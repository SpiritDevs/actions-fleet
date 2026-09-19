import { z } from "zod";
import { DurableObject } from "cloudflare:workers";
import { architectureSchema, heartbeatSchema, hostModeSchema, logLineSchema, platformSchema } from "@actions-fleet/protocol";
import type { AuditEvent, Connection, FleetEvent, Host, Job, Lease, LogLine, Repository, Viewer } from "@actions-fleet/protocol";
import { cookie, cookies, hash, randomToken, verifySignature } from "./crypto.ts";
import { compatible, GitHub } from "./github.ts";
import { preservePatchedRunner } from "./jit.ts";
import { failureContext } from "./failure-context.ts";
import type { GitHubRun } from "./github.ts";
import { after, body, configured, HttpError, id, json, nowIso } from "./types.ts";
import type { Env } from "./types.ts";

const DAY = 86400000;
const SESSION_COOKIE = "fleet_session";
const STATE_COOKIE = "fleet_oauth_state";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const labelsSchema = z.array(z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/)).max(30);
interface HostRow { id: string; token_hash: string; data: string; revoked: number }
interface RepoRow { id: number; data: string; enabled: number; policy_checked_at: string | null }
interface JobRow { id: string; data: string; status: Job["status"]; repository_id: number }
interface LeaseRow {
  id: string; host_id: string; job_id: string; requested_job_id: string; admitted_at: string | null; repository_id: number; run_id: number; run_attempt: number;
  head_sha: string; execution_sha: string | null; runner_name: string; runner_id: number | null; status: string; expires_at: string;
  created_at: string; completed_at: string | null; acknowledged_sequence: number; runner_job_guid: string | null; logs_verified: number;
}
interface WireRepo { id: number; name: string; full_name: string; private: boolean; owner: { login: string } }
interface WireJob {
  id: number; run_id: number; run_attempt?: number; workflow_name?: string; name: string;
  head_branch: string; head_sha: string; status: "queued" | "in_progress" | "completed" | "waiting";
  conclusion: string | null; labels: string[]; runner_name: string | null; created_at: string;
  started_at: string | null; completed_at: string | null; html_url: string;
  steps?: { number: number; name: string; status: string; conclusion: string | null }[];
}
interface Delivery { id: string; event: string; payload: string; attempts: number }

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.FLEET.get(env.FLEET.idFromName("fleet")).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class FleetDO extends DurableObject<Env> {
  private github: GitHub;
  constructor(private state: DurableObjectState, env: Env) {
    super(state, env);
    this.github = new GitHub(env);
    state.blockConcurrencyWhile(async () => {
      this.state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, data TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS enrollments (hash TEXT PRIMARY KEY, name TEXT NOT NULL, expires_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, viewer TEXT NOT NULL, expires_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS oauth_states (hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tickets (hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, expires_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS connections (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS repositories (id INTEGER PRIMARY KEY, data TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, policy_checked_at TEXT);
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL, run_id INTEGER NOT NULL, run_attempt INTEGER NOT NULL, head_sha TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS queued_jobs ON jobs(status, created_at);
        CREATE TABLE IF NOT EXISTS approvals (run_id INTEGER NOT NULL, run_attempt INTEGER NOT NULL, head_sha TEXT NOT NULL, repository_id INTEGER NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(repository_id, run_id, run_attempt, head_sha));
        CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, job_id TEXT NOT NULL, requested_job_id TEXT NOT NULL, admitted_at TEXT, repository_id INTEGER NOT NULL, run_id INTEGER NOT NULL, run_attempt INTEGER NOT NULL, head_sha TEXT NOT NULL, execution_sha TEXT, runner_name TEXT UNIQUE NOT NULL, runner_id INTEGER, status TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT, acknowledged_sequence INTEGER NOT NULL DEFAULT 0, runner_job_guid TEXT, logs_verified INTEGER NOT NULL DEFAULT 0);
        CREATE UNIQUE INDEX IF NOT EXISTS one_host_lease ON leases(host_id) WHERE status IN ('preparing', 'ready', 'admitted', 'recovering');
        CREATE TABLE IF NOT EXISTS logs (lease_id TEXT NOT NULL, sequence INTEGER NOT NULL, job_id TEXT NOT NULL, cursor INTEGER NOT NULL, created_at TEXT NOT NULL, bytes INTEGER NOT NULL, digest TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(lease_id, sequence), UNIQUE(job_id, cursor));
        CREATE INDEX IF NOT EXISTS job_logs ON logs(job_id, cursor);
        CREATE INDEX IF NOT EXISTS log_retention ON logs(created_at);
        CREATE TABLE IF NOT EXISTS log_usage (scope TEXT PRIMARY KEY, bytes INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS log_cursors (job_id TEXT PRIMARY KEY, last_cursor INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL, detail TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, event TEXT NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, error TEXT);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      // Forward-only in-place schema upgrades: deployed objects may already
      // contain enrollments, approvals or spools from an earlier pilot build.
      this.state.storage.transactionSync(() => {
        const columns = (table: string) => new Set(this.rows<{ name: string }>(`PRAGMA table_info(${table})`).map(column => column.name));
        const leaseColumns = columns("leases");
        for (const [name, definition] of Object.entries({ requested_job_id: "TEXT NOT NULL DEFAULT ''", admitted_at: "TEXT", execution_sha: "TEXT", logs_verified: "INTEGER NOT NULL DEFAULT 0" })) {
          if (!leaseColumns.has(name)) this.exec(`ALTER TABLE leases ADD COLUMN ${name} ${definition}`);
        }
        if (!columns("approvals").has("revision")) this.exec("ALTER TABLE approvals ADD COLUMN revision TEXT NOT NULL DEFAULT ''");
        this.exec("UPDATE leases SET requested_job_id=job_id WHERE requested_job_id=''");
        this.exec("UPDATE leases SET admitted_at=created_at,logs_verified=1 WHERE status='admitted' AND admitted_at IS NULL");
        this.exec("DROP INDEX IF EXISTS one_job_lease");
        this.exec("CREATE UNIQUE INDEX one_job_lease ON leases(job_id) WHERE admitted_at IS NOT NULL AND status IN ('admitted','recovering')");
        if (!this.first("SELECT 1 FROM settings WHERE key='log_usage_initialized'")) {
          this.exec("INSERT OR REPLACE INTO log_usage SELECT 'total',COALESCE(SUM(bytes),0) FROM logs");
          this.exec("INSERT OR REPLACE INTO log_usage SELECT 'job:'||job_id,SUM(bytes) FROM logs GROUP BY job_id");
          this.exec("INSERT OR REPLACE INTO settings VALUES ('log_usage_initialized','1')");
        }
      });
      this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
      // Hibernation can reconstruct this object on every new request. Preserve
      // its due alarm so frequent heartbeats cannot postpone recovery forever.
      if (await this.state.storage.getAlarm() === null) await this.state.storage.setAlarm(Date.now() + 60000);
    });
  }
  private rows<T>(query: string, ...values: (string | number | null)[]): T[] {
    return this.state.storage.sql.exec(query, ...values).toArray() as unknown as T[];
  }
  private first<T>(query: string, ...values: (string | number | null)[]): T | undefined { return this.rows<T>(query, ...values)[0]; }
  private exec(query: string, ...values: (string | number | null)[]): void { this.state.storage.sql.exec(query, ...values); }
  private audit(actor: string, action: string, target: string, detail = ""): void {
    this.exec("INSERT INTO audit VALUES (?, ?, ?, ?, ?, ?)", id(), actor, action, target, nowIso(), detail.slice(0, 2000));
  }
  private broadcast(event: FleetEvent): void {
    const message = JSON.stringify(event);
    for (const socket of this.state.getWebSockets()) {
      try { socket.send(message); } catch { socket.close(1011, "Reconnect to resume"); }
    }
  }
  private writeHost(host: Host): void { this.exec("UPDATE hosts SET data = ? WHERE id = ?", JSON.stringify(host), host.id); }
  private writeJob(job: Job, repositoryId: number): void {
    this.exec("INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET repository_id=excluded.repository_id,run_id=excluded.run_id,run_attempt=excluded.run_attempt,head_sha=excluded.head_sha,status=excluded.status,updated_at=excluded.updated_at,data=excluded.data", job.id, repositoryId, job.runId, job.runAttempt, job.headSha, job.status, job.createdAt, nowIso(), JSON.stringify(job));
  }
  private getRepo(repositoryId: number, enabled = false): Repository {
    const row = this.first<RepoRow>("SELECT * FROM repositories WHERE id = ?", repositoryId);
    if (!row || (enabled && !row.enabled)) throw new HttpError(409, "Repository is not enabled for fleet execution");
    return JSON.parse(row.data) as Repository;
  }
  private getJob(jobId: string): { job: Job; repositoryId: number } {
    const row = this.first<JobRow>("SELECT * FROM jobs WHERE id = ?", jobId);
    if (!row) throw new HttpError(404, "Job not found");
    return { job: JSON.parse(row.data) as Job, repositoryId: row.repository_id };
  }
  private requireConfiguration(): void {
    if (!configured(this.env)) throw new HttpError(503, "Finish GitHub App, owner, dashboard and relay configuration before using the fleet");
  }
  private requireOrigin(request: Request): void {
    if (request.headers.get("Origin") !== this.env.DASHBOARD_ORIGIN) throw new HttpError(403, "Request Origin is not the configured dashboard");
  }
  private async session(request: Request): Promise<{ viewer: Viewer; hash: string } | null> {
    const value = cookies(request)[SESSION_COOKIE];
    if (!value || !tokenPattern.test(value)) return null;
    const key = await hash(value);
    const record = this.first<{ viewer: string; expires_at: string }>("SELECT viewer, expires_at FROM sessions WHERE hash = ?", key);
    if (!record || record.expires_at <= nowIso()) return null;
    const viewer = JSON.parse(record.viewer) as Viewer;
    if (viewer.id !== Number(this.env.OWNER_GITHUB_ID)) return null;
    return { viewer, hash: key };
  }
  private async host(request: Request): Promise<{ row: HostRow; host: Host }> {
    const token = request.headers.get("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw new HttpError(401, "A host token is required");
    const row = this.first<HostRow>("SELECT * FROM hosts WHERE token_hash = ?", await hash(token));
    if (!row) throw new HttpError(401, "Host token is invalid");
    return { row, host: JSON.parse(row.data) as Host };
  }
  private async parse<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
    const parsed = schema.safeParse(await body(request));
    if (!parsed.success) throw new HttpError(400, "Request fields are invalid");
    return parsed.data;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method === "GET" && path === "/health") return json({ ok: true, configured: configured(this.env) });
      if (request.method === "GET" && path === "/api/session") return json({ viewer: (await this.session(request))?.viewer ?? null, configured: configured(this.env), loginUrl: "/auth/github" });
      this.requireConfiguration();
      if (path === "/auth/github" && request.method === "GET") return await this.login();
      if (path === "/auth/github/callback" && request.method === "GET") return await this.callback(request);
      if (path === "/auth/cli" && request.method === "POST") return await this.cliLogin(request);
      if (path === "/webhooks/github" && request.method === "POST") return await this.webhook(request);
      if (path === "/live" && request.method === "GET") return await this.live(request);
      if (path.startsWith("/agent/")) return await this.agent(request, path);
      const session = await this.session(request);
      if (!session) throw new HttpError(401, "Sign in with the configured GitHub owner account");
      if (!["GET", "HEAD"].includes(request.method)) this.requireOrigin(request);
      return await this.operator(request, path, url, session);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error("Fleet request failed", error instanceof Error ? error.name : "UnknownError");
      return json({ error: "The relay could not complete the operation; check provider configuration and relay diagnostics" }, 500);
    }
  }

  private async login(): Promise<Response> {
    this.exec("DELETE FROM oauth_states WHERE expires_at < ?", nowIso());
    const count = this.first<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_states")!.n;
    if (count >= 1024) throw new HttpError(429, "Too many pending sign-ins; try again later");
    const state = randomToken();
    this.exec("INSERT INTO oauth_states VALUES (?, ?)", await hash(state), after(600));
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.env.GITHUB_CLIENT_ID);
    url.searchParams.set("redirect_uri", `${this.env.DASHBOARD_ORIGIN}/auth/github/callback`);
    url.searchParams.set("state", state);
    return new Response(null, { status: 302, headers: { Location: url.href, "Set-Cookie": cookie(STATE_COOKIE, state, 600), "Cache-Control": "no-store" } });
  }
  private async callback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const value = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code");
    if (!tokenPattern.test(value) || value !== cookies(request)[STATE_COOKIE] || !code || code.length > 512) throw new HttpError(403, "OAuth state is invalid");
    const key = await hash(value);
    this.state.storage.transactionSync(() => {
      const state = this.first<{ expires_at: string }>("SELECT expires_at FROM oauth_states WHERE hash = ?", key);
      if (!state || state.expires_at <= nowIso()) throw new HttpError(403, "OAuth state has expired or was already used");
      this.exec("DELETE FROM oauth_states WHERE hash = ?", key);
    });
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.env.GITHUB_CLIENT_ID, client_secret: this.env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${this.env.DASHBOARD_ORIGIN}/auth/github/callback` }),
    });
    const result = await response.json() as { access_token?: string };
    if (!response.ok || !result.access_token) throw new HttpError(401, "GitHub sign-in could not be verified");
    const user = await this.github.request<{ id: number; login: string; avatar_url: string }>("/user", result.access_token);
    if (user.id !== Number(this.env.OWNER_GITHUB_ID)) throw new HttpError(403, "This GitHub account is not a fleet operator");
    const viewer: Viewer = { id: user.id, login: user.login, avatarUrl: user.avatar_url };
    const token = randomToken();
    this.exec("INSERT INTO sessions VALUES (?, ?, ?)", await hash(token), JSON.stringify(viewer), after(14 * 86400));
    this.audit(user.login, "session.login", String(user.id));
    const headers = new Headers({ Location: this.env.DASHBOARD_ORIGIN, "Cache-Control": "no-store" });
    headers.append("Set-Cookie", cookie(SESSION_COOKIE, token, 14 * 86400));
    headers.append("Set-Cookie", cookie(STATE_COOKIE, "", 0));
    return new Response(null, { status: 302, headers });
  }
  private async cliLogin(request: Request): Promise<Response> {
    this.requireOrigin(request);
    const credential = request.headers.get("Authorization")?.match(/^Bearer ([A-Za-z0-9_]{10,4096})$/)?.[1];
    if (!credential) throw new HttpError(401, "A GitHub user credential is required");
    // Existing gh CLI user authorization may bootstrap an operator session. The
    // supplied credential is used once at GitHub /user, never stored or logged.
    const user = await this.github.request<{ id: number; login: string; avatar_url: string }>("/user", credential);
    if (user.id !== Number(this.env.OWNER_GITHUB_ID)) throw new HttpError(403, "This GitHub account is not a fleet operator");
    const viewer: Viewer = { id: user.id, login: user.login, avatarUrl: user.avatar_url };
    const token = randomToken();
    this.exec("INSERT INTO sessions VALUES (?,?,?)", await hash(token), JSON.stringify(viewer), after(3600));
    this.audit(user.login, "session.cli_login", String(user.id));
    return json({ viewer, expiresAt: after(3600) }, 200, { "Set-Cookie": cookie(SESSION_COOKIE, token, 3600) });
  }

  private async operator(request: Request, path: string, url: URL, session: { viewer: Viewer; hash: string }): Promise<Response> {
    const viewer = session.viewer;
    if (path === "/api/logout" && request.method === "POST") {
      this.exec("DELETE FROM sessions WHERE hash = ?", session.hash);
      this.exec("DELETE FROM tickets WHERE session_hash = ?", session.hash);
      for (const socket of this.state.getWebSockets()) {
        if ((socket.deserializeAttachment() as { sessionHash: string }).sessionHash === session.hash) socket.close(1008, "Signed out");
      }
      return json({ ok: true }, 200, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
    }
    if (path === "/api/overview" && request.method === "GET") {
      const hosts = this.rows<HostRow>("SELECT * FROM hosts WHERE revoked = 0").map(row => {
        const host = JSON.parse(row.data) as Host;
        const active = this.first<LeaseRow>("SELECT * FROM leases WHERE host_id = ? AND status IN ('preparing','ready','admitted','recovering')", host.id);
        host.currentJobId = active?.job_id ?? null;
        host.status = Date.now() - Date.parse(host.lastSeenAt) > 90000 ? "offline" : active ? "busy" : "online";
        return host;
      });
      return json({ viewer, hosts, jobs: this.rows<JobRow>("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 500").map(row => JSON.parse(row.data) as Job), repositories: this.rows<RepoRow>("SELECT * FROM repositories").map(row => JSON.parse(row.data) as Repository), connections: this.rows<{ data: string }>("SELECT data FROM connections").map(row => JSON.parse(row.data) as Connection), audit: this.rows<AuditEvent>("SELECT id, actor, action, target, created_at AS createdAt, detail FROM audit ORDER BY created_at DESC LIMIT 100") });
    }
    if (["/api/jobs", "/api/audit"].includes(path) && request.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400, "Page limit must be between 1 and 500");
      let cursor: { time: string; id: string } | null = null;
      const encoded = url.searchParams.get("cursor");
      if (encoded) {
        try { cursor = JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/"))); } catch { throw new HttpError(400, "Invalid history cursor"); }
        if (!cursor || typeof cursor.time !== "string" || !Number.isFinite(Date.parse(cursor.time)) || typeof cursor.id !== "string" || cursor.id.length > 128) throw new HttpError(400, "Invalid history cursor");
      }
      const table = path === "/api/jobs" ? "jobs" : "audit";
      const values = cursor ? [cursor.time, cursor.time, cursor.id, limit + 1] : [limit + 1];
      const rows = this.rows<{ id: string; created_at: string; data?: string; actor?: string; action?: string; target?: string; detail?: string }>(`SELECT * FROM ${table} ${cursor ? "WHERE (created_at < ? OR (created_at = ? AND id < ?))" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`, ...values);
      const more = rows.length > limit; const page = rows.slice(0, limit); const last = page.at(-1);
      const nextCursor = more && last ? btoa(JSON.stringify({ time: last.created_at, id: last.id })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_") : null;
      return json({ items: page.map(row => table === "jobs" ? JSON.parse(row.data!) as Job : { id: row.id, actor: row.actor, action: row.action, target: row.target, detail: row.detail, createdAt: row.created_at }), nextCursor });
    }
    const detailMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
    if (detailMatch && request.method === "GET") return json(this.getJob(decodeURIComponent(detailMatch[1]!)).job);
    if (path === "/api/hosts/enrollment" && request.method === "POST") {
      const input = await this.parse(request, z.object({ name: z.string().trim().min(1).max(100) }));
      const token = randomToken(); const expiresAt = after(600);
      this.exec("INSERT INTO enrollments VALUES (?, ?, ?)", await hash(token), input.name, expiresAt);
      this.audit(viewer.login, "host.enrollment_created", input.name);
      return json({ token, expiresAt, relayUrl: this.env.RELAY_PUBLIC_URL });
    }
    const modeMatch = path.match(/^\/api\/hosts\/([^/]+)\/mode$/);
    if (modeMatch && request.method === "POST") {
      const input = await this.parse(request, z.object({ mode: hostModeSchema }));
      const row = this.first<HostRow>("SELECT * FROM hosts WHERE id = ? AND revoked = 0", modeMatch[1]!);
      if (!row) throw new HttpError(404, "Host not found");
      const host = JSON.parse(row.data) as Host; host.mode = input.mode; this.writeHost(host);
      this.audit(viewer.login, "host.mode_requested", host.id, input.mode);
      this.broadcast({ type: "host_mode", hostId: host.id, mode: host.mode });
      return json({ ok: true });
    }
    const hostMatch = path.match(/^\/api\/hosts\/([^/]+)$/);
    if (hostMatch && request.method === "DELETE") {
      const row = this.first<HostRow>("SELECT * FROM hosts WHERE id = ?", hostMatch[1]!);
      if (!row) throw new HttpError(404, "Host not found");
      this.exec("UPDATE hosts SET revoked = 1 WHERE id = ?", row.id);
      this.audit(viewer.login, "host.revoked", row.id);
      this.broadcast({ type: "refresh" }); return json({ ok: true });
    }
    if (path === "/api/connections/install" && request.method === "GET") return json({ url: `https://github.com/apps/${encodeURIComponent(this.env.GITHUB_APP_SLUG)}/installations/new` });
    if (path === "/api/connections/sync" && request.method === "POST") {
      await this.syncConnections(); this.audit(viewer.login, "connections.synced", "fleet"); return json({ ok: true });
    }
    const repositoryMatch = path.match(/^\/api\/repositories\/(\d+)$/);
    if (repositoryMatch && request.method === "POST") {
      const input = await this.parse(request, z.object({ enabled: z.boolean() }));
      const repo = this.getRepo(Number(repositoryMatch[1]));
      if (input.enabled) await this.verifyRepositoryPolicy(repo, true);
      repo.enabled = input.enabled;
      this.exec("UPDATE repositories SET data=?, enabled=?, policy_checked_at=? WHERE id=?", JSON.stringify(repo), Number(input.enabled), input.enabled ? nowIso() : null, repo.id);
      this.audit(viewer.login, input.enabled ? "repository.enabled" : "repository.disabled", repo.fullName);
      this.broadcast({ type: "refresh" }); return json({ ok: true });
    }
    const failureMatch = path.match(/^\/api\/jobs\/([^/]+)\/failure-context$/);
    if (failureMatch && request.method === "GET") {
      const jobId = decodeURIComponent(failureMatch[1]!); this.getJob(jobId);
      return json(failureContext(<T>(query: string, ...values: (string | number)[]) => this.rows<T>(query, ...values), jobId));
    }
    const logsMatch = path.match(/^\/api\/jobs\/([^/]+)\/logs$/);
    if (logsMatch && request.method === "GET") {
      const jobId = decodeURIComponent(logsMatch[1]!); this.getJob(jobId);
      const cursor = Number(url.searchParams.get("after") ?? "0");
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new HttpError(400, "Invalid log cursor");
      const rows = this.rows<{ cursor: number; data: string }>("SELECT cursor,data FROM logs WHERE job_id=? AND cursor>? ORDER BY cursor LIMIT 500", jobId, cursor);
      const minimum = this.first<{ n: number | null }>("SELECT MIN(cursor) AS n FROM logs WHERE job_id=?", jobId)!.n;
      const last = this.first<{ last_cursor: number }>("SELECT last_cursor FROM log_cursors WHERE job_id=?", jobId)?.last_cursor ?? 0;
      const nextCursor = rows.at(-1)?.cursor ?? cursor;
      return json({ lines: rows.map(row => JSON.parse(row.data) as LogLine), nextCursor, truncated: minimum === null ? last > cursor : cursor < minimum - 1, hasMore: last > nextCursor && rows.length > 0 });
    }
    const controlMatch = path.match(/^\/api\/jobs\/([^/]+)\/control$/);
    if (controlMatch && request.method === "POST") {
      const input = await this.parse(request, z.object({ action: z.enum(["cancel", "force_cancel", "rerun", "rerun_failed", "rerun_job", "approve"]) }));
      await this.control(decodeURIComponent(controlMatch[1]!), input.action, viewer.login);
      return json({ ok: true });
    }
    if (path === "/api/live-ticket" && request.method === "POST") {
      const ticket = randomToken(); const expiresAt = after(60);
      this.exec("INSERT INTO tickets VALUES (?, ?, ?)", await hash(ticket), session.hash, expiresAt);
      const liveUrl = new URL("/live", this.env.RELAY_PUBLIC_URL); liveUrl.protocol = liveUrl.protocol === "https:" ? "wss:" : "ws:";
      liveUrl.searchParams.set("ticket", ticket);
      return json({ url: liveUrl.href, expiresAt });
    }
    throw new HttpError(404, "Endpoint not found");
  }

  private async live(request: Request): Promise<Response> {
    this.requireOrigin(request);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "WebSocket upgrade required");
    const token = new URL(request.url).searchParams.get("ticket") ?? "";
    if (!tokenPattern.test(token)) throw new HttpError(401, "Invalid live ticket");
    const key = await hash(token);
    const ticket = this.state.storage.transactionSync(() => {
      const record = this.first<{ session_hash: string; expires_at: string }>("SELECT * FROM tickets WHERE hash=?", key);
      if (!record || record.expires_at <= nowIso()) throw new HttpError(401, "Live ticket expired or already used");
      const session = this.first<{ expires_at: string }>("SELECT expires_at FROM sessions WHERE hash=?", record.session_hash);
      if (!session || session.expires_at <= nowIso()) throw new HttpError(401, "Session expired");
      this.exec("DELETE FROM tickets WHERE hash=?", key); return record;
    });
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ sessionHash: ticket.session_hash });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") socket.send("pong");
    else socket.close(1008, "This socket only receives fleet events");
  }
  webSocketClose(socket: WebSocket, code: number): void { socket.close(code, "Closed"); }
  webSocketError(socket: WebSocket): void { socket.close(1011, "Reconnect to resume"); }

  private async agent(request: Request, path: string): Promise<Response> {
    if (request.method !== "POST") throw new HttpError(405, "POST required");
    if (path === "/agent/enroll") {
      const input = await this.parse(request, z.object({ token: z.string().regex(tokenPattern), name: z.string().trim().min(1).max(100), platform: platformSchema, architecture: architectureSchema, labels: labelsSchema, version: z.string().min(1).max(64) }));
      const enrollmentHash = await hash(input.token); const token = randomToken(); const tokenHash = await hash(token);
      const host: Host = { id: id(), name: input.name, platform: input.platform, architecture: input.architecture, labels: input.labels, version: input.version, mode: "paused", status: "online", enrolledAt: nowIso(), lastSeenAt: nowIso(), metrics: null, currentJobId: null };
      this.state.storage.transactionSync(() => {
        const enrollment = this.first<{ expires_at: string }>("SELECT expires_at FROM enrollments WHERE hash=?", enrollmentHash);
        if (!enrollment || enrollment.expires_at <= nowIso()) throw new HttpError(401, "Enrollment token expired or was already used");
        this.exec("DELETE FROM enrollments WHERE hash=?", enrollmentHash);
        this.exec("INSERT INTO hosts VALUES (?, ?, ?, 0)", host.id, tokenHash, JSON.stringify(host));
        this.audit(`host:${host.id}`, "host.enrolled", host.id, `${host.platform}/${host.architecture}`);
      });
      this.broadcast({ type: "refresh" }); return json({ hostId: host.id, token, mode: host.mode });
    }
    const { host, row } = await this.host(request);
    if (row.revoked) {
      if (path === "/agent/heartbeat") return json({ mode: "paused", revoked: true });
      throw new HttpError(403, "Host has been revoked");
    }
    if (path === "/agent/heartbeat") {
      const input = await this.parse(request, heartbeatSchema.extend({ labels: labelsSchema }));
      // currentJobId is derived from relay leases, never trusted as job ownership.
      const active = this.first<LeaseRow>("SELECT * FROM leases WHERE host_id=? AND status IN ('preparing','ready','admitted','recovering')", host.id);
      host.metrics = input.metrics; host.labels = input.labels; host.version = input.version;
      host.admissionReason = input.admissionReason ?? null;
      host.lastSeenAt = nowIso(); host.currentJobId = active?.job_id ?? null; host.status = active ? "busy" : "online";
      this.writeHost(host); this.broadcast({ type: "refresh" }); return json({ mode: host.mode });
    }
    if (path === "/agent/claim") return json({ lease: await this.claim(host) });
    if (path === "/agent/admission") {
      const input = await this.parse(request, z.object({ leaseId: z.string().uuid(), runId: z.number().int().positive(), runAttempt: z.number().int().positive(), headSha: z.string().regex(/^[0-9a-f]{40,64}$/) }));
      return json(await this.admission(host, input));
    }
    if (path === "/agent/logs") {
      const input = await this.parse(request, z.object({ leaseId: z.string().uuid(), lines: z.array(logLineSchema).min(1).max(1000) }));
      return json({ acknowledgedSequence: await this.ingest(host, input.leaseId, input.lines) });
    }
    const complete = path.match(/^\/agent\/leases\/([^/]+)\/complete$/);
    if (complete) {
      const input = await this.parse(request, z.object({ exitCode: z.number().int(), error: z.string().max(2000).optional() }));
      const lease = this.ownedLease(complete[1]!, host.id);
      if (!["completed", "failed"].includes(lease.status)) {
        // GitHub remains authoritative for workflow conclusion. Runner process exit is separate.
        this.exec("UPDATE leases SET status='completed', completed_at=? WHERE id=?", nowIso(), lease.id);
        this.audit(`host:${host.id}`, "lease.completed", lease.id, JSON.stringify({ exitCode: input.exitCode, error: input.error }));
        if (lease.runner_id !== null) {
          const repo = this.getRepo(lease.repository_id);
          this.state.waitUntil(this.removeRunner(repo, lease.runner_id).catch(() => undefined));
        }
      }
      this.broadcast({ type: "refresh" }); return json({ ok: true });
    }
    throw new HttpError(404, "Agent endpoint not found");
  }

  private ownedLease(leaseId: string, hostId: string): LeaseRow {
    const lease = this.first<LeaseRow>("SELECT * FROM leases WHERE id=? AND host_id=?", leaseId, hostId);
    if (!lease) throw new HttpError(404, "Lease not found for this host");
    return lease;
  }
  private async approved(repo: Repository, job: Job, freshRun?: GitHubRun): Promise<boolean> {
    const run = freshRun ?? await this.github.run(repo.installationId, repo.fullName, job.runId);
    if (run.run_attempt !== job.runAttempt || run.head_sha !== job.headSha || run.repository.id !== repo.id || run.status === "completed") return false;
    const revision = await this.github.revision(repo.installationId, repo.fullName, run);
    if (!revision) return false;
    if (this.first("SELECT 1 FROM approvals WHERE repository_id=? AND run_id=? AND run_attempt=? AND head_sha=? AND revision=?", repo.id, job.runId, job.runAttempt, job.headSha, revision)) return true;
    return this.github.trusted(repo.installationId, repo.fullName, run);
  }
  private async claim(host: Host): Promise<Lease | null> {
    if (host.mode === "paused" || Date.now() - Date.parse(host.lastSeenAt) > 90000) return null;
    if (this.first("SELECT 1 FROM leases WHERE host_id=? AND status IN ('preparing','ready','admitted','recovering')", host.id)) return null;
    const candidates = this.rows<JobRow>("SELECT jobs.* FROM jobs JOIN repositories ON repositories.id=jobs.repository_id WHERE repositories.enabled=1 AND jobs.status IN ('queued','waiting_approval') ORDER BY jobs.created_at LIMIT 100");
    for (const candidate of candidates) {
      const job = JSON.parse(candidate.data) as Job;
      if (!compatible(job.labels, host.platform, host.architecture, host.labels)) continue;
      if (this.first("SELECT 1 FROM leases WHERE (requested_job_id=? AND admitted_at IS NULL AND status IN ('preparing','ready','recovering')) OR (job_id=? AND admitted_at IS NOT NULL AND status IN ('admitted','recovering'))", job.id, job.id)) continue;
      const repo = this.getRepo(candidate.repository_id, true);
      if (!await this.approved(repo, job)) {
        if (job.status !== "waiting_approval") { job.status = "waiting_approval"; this.writeJob(job, repo.id); this.broadcast({ type: "refresh" }); }
        continue;
      }
      await this.verifyRepositoryPolicy(repo, false);
      const current = await this.github.installation<WireJob>(repo.installationId, `/repos/${repo.fullName}/actions/jobs/${job.id}`);
      if (current.status !== "queued" || current.run_id !== job.runId || current.head_sha !== job.headSha) continue;
      const leaseId = id(); const runnerName = `fleet-${host.id.slice(0, 8)}-${leaseId.slice(0, 12)}`; const expiresAt = after(300);
      const reserved = this.state.storage.transactionSync(() => {
        const latestHost = this.first<HostRow>("SELECT * FROM hosts WHERE id=?", host.id);
        if (!latestHost || latestHost.revoked || (JSON.parse(latestHost.data) as Host).mode === "paused") return false;
        if (!this.first<{ enabled: number }>("SELECT enabled FROM repositories WHERE id=?", repo.id)?.enabled) return false;
        if (this.first("SELECT 1 FROM leases WHERE (host_id=? AND status IN ('preparing','ready','admitted','recovering')) OR (requested_job_id=? AND admitted_at IS NULL AND status IN ('preparing','ready','recovering')) OR (job_id=? AND admitted_at IS NOT NULL AND status IN ('admitted','recovering'))", host.id, job.id, job.id)) return false;
        this.exec("INSERT INTO leases(id,host_id,job_id,requested_job_id,repository_id,run_id,run_attempt,head_sha,runner_name,status,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,'preparing',?,?)", leaseId, host.id, job.id, job.id, repo.id, job.runId, job.runAttempt, job.headSha, runnerName, expiresAt, nowIso());
        return true;
      });
      if (!reserved) return null;
      try {
        const jit = await this.github.installation<{ encoded_jit_config: string; runner: { id: number } }>(repo.installationId, `/repos/${repo.fullName}/actions/runners/generate-jitconfig`, "POST", { name: runnerName, runner_group_id: 1, labels: [...new Set(["self-hosted", host.platform === "darwin" ? "macOS" : "Linux", host.architecture.toUpperCase(), ...job.labels])], work_folder: "_work" });
        const encodedJitConfig = preservePatchedRunner(jit.encoded_jit_config, runnerName);
        this.exec("UPDATE leases SET runner_id=? WHERE id=?", jit.runner.id, leaseId);
        if (this.ownedLease(leaseId, host.id).status !== "preparing") throw new HttpError(409, "Registration expired while GitHub was responding; wait for reconciliation");
        this.exec("UPDATE leases SET status='ready' WHERE id=?", leaseId);
        this.audit(`host:${host.id}`, "lease.reserved", leaseId, `run=${job.runId}; attempt=${job.runAttempt}; sha=${job.headSha}`);
        this.broadcast({ type: "refresh" });
        return { id: leaseId, jobId: job.id, repository: repo.fullName, runId: job.runId, runAttempt: job.runAttempt, headSha: job.headSha, runnerName, encodedJitConfig, expiresAt };
      } catch (error) {
        // A failed HTTP response may still have created the runner: retain the reservation
        // until recovery lists by its unique name and proves it is safe to remove.
        this.audit("relay", "lease.registration_uncertain", leaseId);
        throw error;
      }
    }
    return null;
  }
  private async admission(host: Host, input: { leaseId: string; runId: number; runAttempt: number; headSha: string }): Promise<{ allowed: boolean; job?: Pick<Lease, "jobId" | "repository" | "runId" | "runAttempt" | "headSha"> }> {
    const lease = this.ownedLease(input.leaseId, host.id);
    const denied = (reason: string) => {
      this.audit(`host:${host.id}`, "admission.denied", lease.id, `run=${input.runId}; attempt=${input.runAttempt}; ${reason}`);
      return { allowed: false } as const;
    };
    if (lease.status === "recovering") throw new HttpError(503, "Runner assignment is being reconciled; retry admission shortly");
    if (!["ready", "admitted"].includes(lease.status)) return denied("Runner lease is no longer ready or admitted");
    const repo = this.getRepo(lease.repository_id, true);
    const run = await this.github.run(repo.installationId, repo.fullName, input.runId);
    if (run.repository.id !== repo.id || run.run_attempt !== input.runAttempt) return denied("GitHub repository or run attempt does not match");
    if (!await this.github.executionRevision(repo.installationId, repo.fullName, run, input.headSha)) return denied("GitHub did not verify the execution revision or current pull request revision");
    let assigned: WireJob | undefined;
    for (let page = 1; page <= 10; page++) {
      const result = await this.github.installation<{ jobs: WireJob[] }>(repo.installationId, `/repos/${repo.fullName}/actions/runs/${input.runId}/attempts/${input.runAttempt}/jobs?per_page=100&page=${page}`);
      assigned = result.jobs.find(job => job.runner_name === lease.runner_name && job.status === "in_progress");
      if (assigned || result.jobs.length < 100) break;
    }
    if (!assigned) throw new HttpError(503, "GitHub has not exposed this runner's in-progress assignment yet; retry admission shortly");
    if (assigned.run_id !== input.runId || (assigned.run_attempt ?? run.run_attempt) !== input.runAttempt || assigned.head_sha !== run.head_sha || !compatible(assigned.labels, host.platform, host.architecture, host.labels)) {
      return denied("GitHub did not confirm a compatible job assigned to this runner");
    }
    this.upsertJob(repo, assigned, run.actor.login, run);
    const { job } = this.getJob(String(assigned.id));
    if (!await this.approved(repo, job, run)) return denied("The current run revision is not approved or its actor is not a verified repository writer");
    await this.verifyRepositoryPolicy(repo, false);
    const accepted = this.state.storage.transactionSync(() => {
      const current = this.ownedLease(lease.id, host.id);
      const hostRow = this.first<HostRow>("SELECT * FROM hosts WHERE id=?", host.id);
      const enabled = this.first<{ enabled: number }>("SELECT enabled FROM repositories WHERE id=?", repo.id)?.enabled;
      if (!hostRow || hostRow.revoked || !enabled || !["ready", "admitted"].includes(current.status)) return false;
      // expires_at limits unused registration capacity. GitHub has now proved
      // this runner is executing a job; slow action preparation must not expire it.
      if (current.status === "ready" && (JSON.parse(hostRow.data) as Host).mode === "paused") return false;
      if (current.admitted_at && (current.job_id !== job.id || current.run_id !== input.runId || current.run_attempt !== input.runAttempt || current.head_sha !== run.head_sha || current.execution_sha !== input.headSha)) return false;
      if (this.first("SELECT 1 FROM leases WHERE job_id=? AND id<>? AND admitted_at IS NOT NULL AND status IN ('admitted','recovering')", job.id, lease.id)) return false;
      if (current.acknowledged_sequence > 0 && current.job_id !== job.id) return false;
      this.exec("UPDATE leases SET status='admitted',logs_verified=1,admitted_at=COALESCE(admitted_at,?),job_id=?,run_id=?,run_attempt=?,head_sha=?,execution_sha=? WHERE id=?", nowIso(), job.id, input.runId, input.runAttempt, run.head_sha, input.headSha, lease.id);
      job.status = "in_progress"; job.startedAt = assigned.started_at; job.hostId = host.id; job.runnerName = lease.runner_name; this.writeJob(job, repo.id);
      return true;
    });
    if (accepted) { this.audit(`host:${host.id}`, "admission.confirmed", lease.id, input.headSha); this.broadcast({ type: "refresh" }); }
    return accepted ? { allowed: true, job: { jobId: job.id, repository: repo.fullName, runId: input.runId, runAttempt: input.runAttempt, headSha: input.headSha } } : denied("Host, repository, or lease admission changed during verification");
  }

  private async ingest(host: Host, leaseId: string, lines: LogLine[]): Promise<number> {
    const lease = this.ownedLease(leaseId, host.id);
    if (lines.some(line => line.runId !== lease.run_id || line.runAttempt !== lease.run_attempt)) throw new HttpError(422, "Log identity differs from the leased run; quarantine these diagnostics locally");
    // Setup and denied-hook diagnostics precede admission. Verify their actual
    // GitHub assignment independently; permission to upload never admits code.
    if (!lease.logs_verified) {
      const repo = this.getRepo(lease.repository_id);
      const assigned = await this.github.installation<WireJob>(repo.installationId, `/repos/${repo.fullName}/actions/jobs/${lease.job_id}`);
      if (assigned.id !== Number(lease.job_id) || assigned.run_id !== lease.run_id || assigned.run_attempt !== lease.run_attempt || assigned.head_sha !== lease.head_sha || assigned.runner_name !== lease.runner_name || !["in_progress", "completed"].includes(assigned.status)) {
        throw new HttpError(["completed", "failed"].includes(lease.status) ? 422 : 409, "GitHub has not verified the log job/runner assignment; preserve the local diagnostics");
      }
      this.exec("UPDATE leases SET logs_verified=1 WHERE id=?", lease.id);
    }
    const prepared = await Promise.all(lines.map(async line => ({ line, digest: await hash(JSON.stringify(line)), bytes: new TextEncoder().encode(JSON.stringify(line)).byteLength })));
    const emitted: LogLine[] = [];
    const acknowledged = this.state.storage.transactionSync(() => {
      const current = this.ownedLease(leaseId, host.id);
      let ack = current.acknowledged_sequence;
      let cursor = this.first<{ last_cursor: number }>("SELECT last_cursor FROM log_cursors WHERE job_id=?", lease.job_id)?.last_cursor ?? 0;
      let newBytes = 0;
      let guid = current.runner_job_guid;
      for (const item of prepared) {
        if (guid !== null && guid !== item.line.jobId) throw new HttpError(409, "Runner job identity changed within a lease");
        guid ??= item.line.jobId;
        if (item.line.sequence <= ack) {
          const stored = this.first<{ digest: string }>("SELECT digest FROM logs WHERE lease_id=? AND sequence=?", leaseId, item.line.sequence);
          if (stored && stored.digest !== item.digest) throw new HttpError(409, "A replayed log sequence has different content");
          continue;
        }
        if (item.line.sequence !== ack + 1) throw new HttpError(409, `Expected log sequence ${ack + 1}`);
        const canonical: LogLine = { ...item.line, jobId: lease.job_id, sequence: ++cursor };
        this.exec("INSERT INTO logs VALUES (?,?,?,?,?,?,?,?)", leaseId, item.line.sequence, lease.job_id, cursor, nowIso(), item.bytes, item.digest, JSON.stringify(canonical));
        newBytes += item.bytes;
        ack = item.line.sequence; emitted.push(canonical);
      }
      this.exec("INSERT INTO log_cursors VALUES (?,?) ON CONFLICT(job_id) DO UPDATE SET last_cursor=excluded.last_cursor", lease.job_id, cursor);
      this.exec("UPDATE leases SET acknowledged_sequence=?, runner_job_guid=? WHERE id=?", ack, guid, leaseId);
      this.exec("UPDATE log_usage SET bytes=bytes+? WHERE scope='total'", newBytes);
      this.exec("INSERT INTO log_usage VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET bytes=log_usage.bytes+excluded.bytes", `job:${lease.job_id}`, newBytes);
      // Acknowledgment records successful ingestion, independently of retained
      // history. Evict complete oldest records, including earlier records in an
      // oversized batch, so a noisy job cannot permanently block its host spool.
      const jobBytes = this.first<{ bytes: number }>("SELECT bytes FROM log_usage WHERE scope=?", `job:${lease.job_id}`)?.bytes ?? 0;
      this.evictLogPrefix(jobBytes - this.logLimit(this.env.MAX_JOB_LOG_BYTES, 33554432), lease.job_id);
      const totalBytes = this.first<{ bytes: number }>("SELECT bytes FROM log_usage WHERE scope='total'")!.bytes;
      this.evictLogPrefix(totalBytes - this.logLimit(this.env.MAX_LOG_BYTES, 268435456));
      return ack;
    });
    if (emitted.length) this.broadcast({ type: "logs", jobId: lease.job_id, lines: emitted });
    return acknowledged;
  }
  private logLimit(value: string | undefined, fallback: number): number {
    const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private evictLogPrefix(requiredBytes: number, jobId?: string): void {
    while (requiredBytes > 0) {
      // Reading only record sizes bounds each eviction batch. rowid follows
      // insertion order, including when wall-clock time moves backwards; each
      // job therefore always loses a prefix, which its replay API can disclose.
      const candidates = jobId
        ? this.rows<{ rowid: number; job_id: string; cursor: number; bytes: number }>("SELECT rowid,job_id,cursor,bytes FROM logs WHERE job_id=? ORDER BY cursor LIMIT 500", jobId)
        : this.rows<{ rowid: number; job_id: string; cursor: number; bytes: number }>("SELECT rowid,job_id,cursor,bytes FROM logs ORDER BY rowid LIMIT 500");
      if (!candidates.length) break;
      let removedBytes = 0;
      let last = candidates[0]!;
      const removedByJob = new Map<string, number>();
      for (const candidate of candidates) {
        last = candidate; removedBytes += candidate.bytes;
        removedByJob.set(candidate.job_id, (removedByJob.get(candidate.job_id) ?? 0) + candidate.bytes);
        if (removedBytes >= requiredBytes) break;
      }
      if (jobId) this.exec("DELETE FROM logs WHERE job_id=? AND cursor<=?", jobId, last.cursor);
      else this.exec("DELETE FROM logs WHERE rowid<=?", last.rowid);
      for (const [removedJobId, bytes] of removedByJob) this.exec("UPDATE log_usage SET bytes=MAX(0,bytes-?) WHERE scope=?", bytes, `job:${removedJobId}`);
      this.exec("UPDATE log_usage SET bytes=MAX(0,bytes-?) WHERE scope='total'", removedBytes);
      requiredBytes -= removedBytes;
    }
  }

  private async syncConnections(): Promise<void> {
    const installations: { id: number; suspended_at: string | null; account: { login: string; type: string } }[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = await this.github.app<typeof installations>(`/app/installations?per_page=100&page=${page}`);
      installations.push(...result); if (result.length < 100) break;
      if (page === 10) throw new HttpError(422, "Installation count exceeds the configured fleet scope");
    }
    const repositories: Repository[] = []; const connections: Connection[] = [];
    for (const installation of installations) {
      if (installation.suspended_at) continue;
      let count = 0;
      for (let page = 1; page <= 10; page++) {
        const result = await this.github.installation<{ repositories: WireRepo[] }>(installation.id, `/installation/repositories?per_page=100&page=${page}`);
        for (const repo of result.repositories) {
          const previous = this.first<RepoRow>("SELECT * FROM repositories WHERE id=?", repo.id);
          const prior = previous ? JSON.parse(previous.data) as Repository : null;
          repositories.push({ id: repo.id, installationId: installation.id, owner: repo.owner.login, name: repo.name, fullName: repo.full_name, private: repo.private, enabled: !!previous?.enabled && prior?.installationId === installation.id && prior?.fullName === repo.full_name && prior?.private === repo.private, approvalPolicy: "all_external_contributors" }); count++;
        }
        if (result.repositories.length < 100) break;
        if (page === 10) throw new HttpError(422, "Repository count exceeds the configured fleet scope");
      }
      connections.push({ id: installation.id, account: installation.account.login, accountType: installation.account.type, repositoryCount: count });
    }
    this.state.storage.transactionSync(() => {
      this.exec("DELETE FROM connections");
      for (const connection of connections) this.exec("INSERT INTO connections VALUES (?,?)", connection.id, JSON.stringify(connection));
      const seen = new Set(repositories.map(repo => repo.id));
      for (const row of this.rows<RepoRow>("SELECT * FROM repositories")) {
        if (!seen.has(row.id)) { const repo = JSON.parse(row.data) as Repository; repo.enabled = false; this.exec("UPDATE repositories SET enabled=0,data=?,policy_checked_at=NULL WHERE id=?", JSON.stringify(repo), row.id); }
      }
      for (const repo of repositories) {
        // A sync's network calls can interleave with an operator disabling a
        // repository. Re-read its policy inside this transaction, never restore
        // a stale enabled flag captured before that operator action.
        const current = this.first<RepoRow>("SELECT * FROM repositories WHERE id=?", repo.id);
        const prior = current ? JSON.parse(current.data) as Repository : null;
        repo.enabled = !!current?.enabled && prior?.installationId === repo.installationId && prior?.fullName === repo.fullName && prior?.private === repo.private;
        this.exec("INSERT INTO repositories VALUES (?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET data=excluded.data,enabled=excluded.enabled", repo.id, JSON.stringify(repo), Number(repo.enabled));
      }
    });
    this.broadcast({ type: "refresh" });
  }
  private async verifyRepositoryPolicy(repo: Repository, configure: boolean): Promise<void> {
    try {
      if (repo.private) {
        const path = `/repos/${repo.fullName}/actions/permissions/fork-pr-workflows-private-repos`;
        let policy = await this.github.installation<{ run_workflows_from_fork_pull_requests: boolean; require_approval_for_fork_pr_workflows: boolean; send_write_tokens_to_workflows: boolean; send_secrets_and_variables: boolean }>(repo.installationId, path);
        if (configure && policy.run_workflows_from_fork_pull_requests && !policy.require_approval_for_fork_pr_workflows) {
          await this.github.installation(repo.installationId, path, "PUT", { ...policy, require_approval_for_fork_pr_workflows: true });
          policy = await this.github.installation(repo.installationId, path);
        }
        if (policy.run_workflows_from_fork_pull_requests && !policy.require_approval_for_fork_pr_workflows) throw new Error("Unsafe private fork policy");
      } else {
        const path = `/repos/${repo.fullName}/actions/permissions/fork-pr-contributor-approval`;
        let policy = await this.github.installation<{ approval_policy: string }>(repo.installationId, path);
        if (configure && policy.approval_policy !== "all_external_contributors") {
          await this.github.installation(repo.installationId, path, "PUT", { approval_policy: "all_external_contributors" });
          policy = await this.github.installation(repo.installationId, path);
        }
        if (policy.approval_policy !== "all_external_contributors") throw new Error("Unsafe contributor approval policy");
      }
    } catch {
      throw new HttpError(409, "Repository enrollment requires verified approval for every outside contributor. Grant the App repository Administration permission and allow this policy under the account's Actions settings");
    }
  }

  private async control(jobId: string, action: string, actor: string): Promise<void> {
    const { job, repositoryId } = this.getJob(jobId); const repo = this.getRepo(repositoryId);
    const run = await this.github.run(repo.installationId, repo.fullName, job.runId);
    if (action === "approve") {
      if (run.head_sha !== job.headSha || run.run_attempt !== job.runAttempt || run.repository.id !== repo.id) throw new HttpError(409, "Run revision changed; refresh before approving");
      if (run.status === "completed") throw new HttpError(409, "Completed runs cannot be approved");
      const revision = await this.github.revision(repo.installationId, repo.fullName, run);
      if (!revision) throw new HttpError(409, "GitHub cannot verify the current pull request revision for this run; refresh its metadata before approving");
      // GitHub's own external-contributor gate is separate from fleet admission.
      if (["action_required", "waiting", "requested"].includes(run.status) || job.id.startsWith("run:")) await this.github.installation(repo.installationId, `/repos/${repo.fullName}/actions/runs/${job.runId}/approve`, "POST");
      this.exec("INSERT OR REPLACE INTO approvals VALUES (?,?,?,?,?,?,?)", job.runId, job.runAttempt, job.headSha, repo.id, actor, nowIso(), revision);
      for (const row of this.rows<JobRow>("SELECT * FROM jobs WHERE repository_id=? AND run_id=? AND run_attempt=? AND head_sha=? AND status='waiting_approval'", repo.id, job.runId, job.runAttempt, job.headSha)) {
        const candidate = JSON.parse(row.data) as Job; candidate.status = "queued"; this.writeJob(candidate, repo.id);
      }
      this.audit(actor, "run.approved", String(job.runId), `attempt=${job.runAttempt}; sha=${job.headSha}`);
    } else {
      const paths: Record<string, string> = { cancel: "cancel", force_cancel: "force-cancel", rerun: "rerun", rerun_failed: "rerun-failed-jobs" };
      if (action === "rerun_job" && !/^\d+$/.test(job.id)) throw new HttpError(409, "This pending workflow has no GitHub job to rerun");
      const path = action === "rerun_job" ? `/repos/${repo.fullName}/actions/jobs/${job.id}/rerun` : `/repos/${repo.fullName}/actions/runs/${job.runId}/${paths[action]}`;
      this.audit(actor, `${action}.requested`, action === "rerun_job" ? job.id : String(job.runId));
      await this.github.installation(repo.installationId, path, "POST");
      this.audit(actor, `${action}.accepted_by_github`, action === "rerun_job" ? job.id : String(job.runId), "Final status awaits GitHub reconciliation");
    }
    this.broadcast({ type: "refresh" });
  }

  private async webhook(request: Request): Promise<Response> {
    if (Number(request.headers.get("Content-Length") ?? "0") > 1048576) throw new HttpError(413, "Webhook is too large");
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 1048576) throw new HttpError(413, "Webhook is too large");
    if (!await verifySignature(this.env.GITHUB_WEBHOOK_SECRET, bytes, request.headers.get("X-Hub-Signature-256") ?? "")) throw new HttpError(401, "Webhook signature is invalid");
    const delivery = request.headers.get("X-GitHub-Delivery") ?? ""; const event = request.headers.get("X-GitHub-Event") ?? "";
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(delivery)) throw new HttpError(400, "Webhook delivery identifier is missing");
    const payload = new TextDecoder().decode(bytes); const digest = await hash(payload);
    try { JSON.parse(payload); } catch { throw new HttpError(400, "Invalid webhook JSON"); }
    const previous = this.first<{ digest: string; event: string }>("SELECT digest,event FROM deliveries WHERE id=?", delivery);
    if (previous && (previous.digest !== digest || previous.event !== event)) throw new HttpError(409, "Webhook delivery identifier was reused with another payload or event");
    if (!previous) this.exec("INSERT INTO deliveries VALUES (?,?,?,?, 'pending', 0, ?, NULL)", delivery, event, digest, payload, nowIso());
    this.state.waitUntil(this.processDelivery(delivery));
    return json({ ok: true }, 202);
  }
  private async processDelivery(deliveryId: string): Promise<void> {
    const record = this.first<Delivery>("SELECT * FROM deliveries WHERE id=? AND status='pending'", deliveryId);
    if (!record) return;
    this.exec("UPDATE deliveries SET status='processing',attempts=attempts+1 WHERE id=?", deliveryId);
    try {
      const payload = JSON.parse(record.payload) as { action: string; installation?: { id: number }; repository?: WireRepo; workflow_job?: WireJob; workflow_run?: GitHubRun; sender?: { login: string } };
      if (["installation", "installation_repositories", "repository"].includes(record.event)) await this.syncConnections();
      else if (payload.repository && payload.installation) {
        const existing = this.first<RepoRow>("SELECT * FROM repositories WHERE id=?", payload.repository.id);
        if (existing) {
          const repo = JSON.parse(existing.data) as Repository;
          if (repo.installationId === payload.installation.id) {
            if (record.event === "workflow_job" && payload.workflow_job) this.upsertJob(repo, payload.workflow_job, payload.sender?.login ?? "");
            if (record.event === "workflow_run" && payload.workflow_run) await this.reconcileRun(repo, payload.workflow_run);
          }
        }
      }
      this.exec("UPDATE deliveries SET status='complete',payload='',error=NULL WHERE id=?", deliveryId);
      this.broadcast({ type: "refresh" });
    } catch (error) {
      this.exec("UPDATE deliveries SET status='pending',error=? WHERE id=?", error instanceof HttpError ? error.message : "Webhook reconciliation failed", deliveryId);
    }
  }
  private upsertJob(repo: Repository, wire: WireJob, actor: string, run?: GitHubRun): void {
    const previous = this.first<JobRow>("SELECT * FROM jobs WHERE id=?", String(wire.id));
    const old = previous ? JSON.parse(previous.data) as Job : null;
    // Delayed queued webhooks must not rewind a completed or running job.
    if (old?.status === "completed" && wire.status !== "completed") return;
    if (old?.status === "in_progress" && wire.status === "queued") return;
    const lease = wire.runner_name ? this.first<LeaseRow>("SELECT * FROM leases WHERE runner_name=? ORDER BY created_at DESC LIMIT 1", wire.runner_name) : undefined;
    const job: Job = { id: String(wire.id), runId: wire.run_id, runAttempt: wire.run_attempt ?? run?.run_attempt ?? old?.runAttempt ?? 1, repository: repo.fullName, installationId: repo.installationId, workflowName: wire.workflow_name ?? run?.name ?? old?.workflowName ?? "", name: wire.name, branch: wire.head_branch ?? run?.head_branch ?? "", headSha: wire.head_sha, actor: run?.actor.login ?? old?.actor ?? actor, status: wire.status === "waiting" ? "waiting_approval" : wire.status, conclusion: wire.conclusion, labels: wire.labels ?? [], hostId: lease?.host_id ?? old?.hostId ?? null, runnerName: wire.runner_name || lease?.runner_name || null, createdAt: wire.created_at ?? old?.createdAt ?? nowIso(), startedAt: wire.started_at, completedAt: wire.completed_at, htmlUrl: wire.html_url, steps: wire.steps ?? old?.steps ?? [] };
    this.writeJob(job, repo.id);
    this.exec("DELETE FROM jobs WHERE id=?", `run:${job.runId}:${job.runAttempt}`);
  }
  private async reconcileRun(repo: Repository, run: GitHubRun): Promise<void> {
    let count = 0;
    for (let page = 1; page <= 10; page++) {
      const result = await this.github.installation<{ jobs: WireJob[] }>(repo.installationId, `/repos/${repo.fullName}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
      for (const job of result.jobs) { this.upsertJob(repo, job, run.actor.login, run); count++; }
      if (result.jobs.length < 100) break;
    }
    if (!count && ["action_required", "waiting", "requested"].includes(run.status)) {
      // Real run projection, explicitly named as waiting for a workflow approval;
      // there is no fabricated numeric GitHub job or claimable label.
      const job: Job = { id: `run:${run.id}:${run.run_attempt}`, runId: run.id, runAttempt: run.run_attempt, repository: repo.fullName, installationId: repo.installationId, workflowName: run.name, name: "Awaiting workflow approval", branch: run.head_branch, headSha: run.head_sha, actor: run.actor.login, status: "waiting_approval", conclusion: null, labels: [], hostId: null, runnerName: null, createdAt: nowIso(), startedAt: null, completedAt: null, htmlUrl: run.html_url, steps: [] };
      this.writeJob(job, repo.id);
    }
  }

  private async removeRunner(repo: Repository, runnerId: number): Promise<void> {
    try { await this.github.installation(repo.installationId, `/repos/${repo.fullName}/actions/runners/${runnerId}`, "DELETE"); }
    catch (error) { if (!(error instanceof HttpError && error.status === 404)) throw error; }
  }
  private async recoverLease(lease: LeaseRow): Promise<void> {
    const repo = this.getRepo(lease.repository_id);
    if (lease.admitted_at) {
      const job = await this.github.installation<WireJob>(repo.installationId, `/repos/${repo.fullName}/actions/jobs/${lease.job_id}`);
      if (job.status === "completed") {
        this.exec("UPDATE leases SET status='completed',completed_at=? WHERE id=?", nowIso(), lease.id); this.upsertJob(repo, job, "");
        if (lease.runner_id !== null) await this.removeRunner(repo, lease.runner_id);
      }
      return;
    }
    // Fetches yield to other requests: never downgrade a concurrently admitted lease.
    const current = this.ownedLease(lease.id, lease.host_id);
    if (current.status === "admitted" || current.expires_at > nowIso() || ["completed", "failed"].includes(current.status)) return;
    // Reserve the slot throughout the recovery API calls and deny a late admission.
    this.exec("UPDATE leases SET status='recovering' WHERE id=? AND status IN ('preparing','ready','recovering')", lease.id);
    try {
      let runner: { id: number; name: string; busy: boolean; status: string } | undefined;
      for (let page = 1; page <= 10; page++) {
        const result = await this.github.installation<{ runners: { id: number; name: string; busy: boolean; status: string }[] }>(repo.installationId, `/repos/${repo.fullName}/actions/runners?per_page=100&page=${page}`);
        runner = result.runners.find(candidate => candidate.name === lease.runner_name);
        if (runner || result.runners.length < 100) break;
        if (page === 10) throw new Error("Runner reconciliation exceeded page limit");
      }
      if (this.ownedLease(lease.id, lease.host_id).status !== "recovering") return;
      if (runner?.busy) {
        this.exec("UPDATE leases SET status='ready',expires_at=? WHERE id=?", after(120), lease.id); return;
      }
      if (runner) await this.removeRunner(repo, runner.id);
      this.exec("UPDATE leases SET status='failed',completed_at=? WHERE id=?", nowIso(), lease.id);
      this.audit("relay", "lease.expired_after_reconciliation", lease.id);
    } catch (error) {
      // Keep recovering (and its unique host/job reservation) until GitHub can
      // positively establish that the old capacity is no longer executing.
      throw error;
    }
  }
  async alarm(): Promise<void> {
    try {
      const now = nowIso(); const logCutoff = new Date(Date.now() - 30 * DAY).toISOString(); const metadataCutoff = new Date(Date.now() - 90 * DAY).toISOString();
      this.state.storage.transactionSync(() => {
        for (const table of ["oauth_states", "sessions", "tickets", "enrollments"]) this.exec(`DELETE FROM ${table} WHERE expires_at < ?`, now);
        const expired = this.rows<{ job_id: string; bytes: number }>("SELECT job_id,SUM(bytes) AS bytes FROM logs WHERE created_at < ? GROUP BY job_id", logCutoff);
        for (const item of expired) this.exec("UPDATE log_usage SET bytes=MAX(0,bytes-?) WHERE scope=?", item.bytes, `job:${item.job_id}`);
        this.exec("UPDATE log_usage SET bytes=MAX(0,bytes-?) WHERE scope='total'", expired.reduce((sum, item) => sum + item.bytes, 0));
        this.exec("DELETE FROM logs WHERE created_at < ?", logCutoff);
        this.exec("DELETE FROM log_usage WHERE bytes=0 AND scope<>'total'");
        this.exec("DELETE FROM audit WHERE created_at < ?", metadataCutoff);
        this.exec("DELETE FROM deliveries WHERE created_at < ?", metadataCutoff);
        this.exec("DELETE FROM approvals WHERE created_at < ?", metadataCutoff);
        this.exec("DELETE FROM leases WHERE completed_at < ? AND status IN ('completed','failed')", metadataCutoff);
        this.exec("DELETE FROM log_cursors WHERE job_id IN (SELECT id FROM jobs WHERE updated_at < ? AND status='completed')", metadataCutoff);
        this.exec("DELETE FROM jobs WHERE updated_at < ? AND status='completed'", metadataCutoff);
        this.exec("UPDATE deliveries SET status='pending' WHERE status='processing'");
      });
      for (const socket of this.state.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as { sessionHash: string };
        if (!this.first("SELECT 1 FROM sessions WHERE hash=?", attachment.sessionHash)) socket.close(1008, "Session expired");
      }
      if (configured(this.env)) {
        for (const delivery of this.rows<Delivery>("SELECT * FROM deliveries WHERE status='pending' ORDER BY created_at LIMIT 20")) await this.processDelivery(delivery.id);
        for (const lease of this.rows<LeaseRow>("SELECT * FROM leases WHERE status IN ('preparing','ready','admitted','recovering') LIMIT 100")) {
          try { await this.recoverLease(lease); } catch { /* Preserve admission reservation when reconciliation is unavailable. */ }
        }
        // Recover missed webhooks for enabled repositories. API responses remain
        // authoritative; no local process result fabricates a GitHub conclusion.
        for (const row of this.rows<RepoRow>("SELECT repositories.* FROM repositories LEFT JOIN settings ON settings.key='reconcile:'||repositories.id WHERE enabled=1 ORDER BY COALESCE(settings.value,'') LIMIT 20")) {
          const repo = JSON.parse(row.data) as Repository;
          const last = this.first<{ value: string }>("SELECT value FROM settings WHERE key=?", `reconcile:${repo.id}`)?.value;
          if (last && Date.now() - Date.parse(last) < 300000) continue;
          this.exec("INSERT OR REPLACE INTO settings VALUES (?,?)", `reconcile:${repo.id}`, nowIso());
          try {
            const runs = await this.github.installation<{ workflow_runs: GitHubRun[] }>(repo.installationId, `/repos/${repo.fullName}/actions/runs?per_page=20`);
            for (const run of runs.workflow_runs) {
              const known = this.first<{ n: number; pending: number }>("SELECT COUNT(*) AS n,COALESCE(SUM(status<>'completed'),0) AS pending FROM jobs WHERE run_id=? AND run_attempt=?", run.id, run.run_attempt)!;
              if (run.status !== "completed" || !known.n || known.pending) await this.reconcileRun(repo, run);
            }
          } catch { /* Retry at the next alarm without admitting unverifiable work. */ }
        }
      }
      this.broadcast({ type: "refresh" });
    } finally { await this.state.storage.setAlarm(Date.now() + 60000); }
  }
}
