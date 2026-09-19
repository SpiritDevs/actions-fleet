import { createHmac, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Lease, LogLine, Overview } from "@actions-fleet/protocol";

const root = fileURLToPath(new NodeURL("../../..", import.meta.url));
const origin = "https://dashboard.example";
const relayUrl = "https://relay.example";
const secret = "test-webhook-secret";
const sha = "a".repeat(40);
const repository = { id: 11, name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" }, default_branch: "main" };
const run = { id: 21, run_attempt: 1, head_sha: sha, head_branch: "main", event: "push", status: "queued", conclusion: null, name: "CI", html_url: "https://github.com/owner/repo/actions/runs/21", actor: { id: 2592956, login: "owner" }, pull_requests: [], repository };
const wireJob = { id: 31, run_id: 21, run_attempt: 1, head_sha: sha, head_branch: "main", workflow_name: "CI", name: "Build", status: "queued", conclusion: null as string | null, labels: ["self-hosted", "fleet-macos-arm64"], runner_name: null as string | null, created_at: new Date().toISOString(), started_at: null as string | null, completed_at: null as string | null, html_url: "https://github.com/owner/repo/actions/runs/21/job/31", steps: [] };
const jobs = [wireJob];
const runs = [run];
let mf: Miniflare;
let sessionCookie = "";
let hostToken = "";
let hostId = "";
let lease: Lease;
let firstLogLine: LogLine;
let assignedLease: Lease;
let jitCalls = 0;
let approvalPolicy = "first_time_contributors";
let oauthUserId = 2592956;
const controls: string[] = [];
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

async function api(path: string, data?: unknown, headers: Record<string, string> = {}) {
  return mf.dispatchFetch(`${relayUrl}${path}`, { redirect: "manual", method: data === undefined ? "GET" : "POST", headers: { Cookie: sessionCookie, Origin: origin, "Content-Type": "application/json", ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
}
const host = (path: string, data: unknown = {}) => api(path, data, { Authorization: `Bearer ${hostToken}` });
async function webhook(delivery = "delivery-1", job = wireJob, signatureOverride?: string) {
  const payload = JSON.stringify({ action: job.status, installation: { id: 7 }, repository, workflow_job: job, sender: { login: "owner" } });
  return mf.dispatchFetch(`${relayUrl}/webhooks/github`, { method: "POST", headers: { "X-GitHub-Delivery": delivery, "X-GitHub-Event": "workflow_job", "X-Hub-Signature-256": signatureOverride ?? `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}` }, body: payload });
}
async function signIn(user = 2592956) {
  oauthUserId = user;
  const start = await api("/auth/github");
  const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
  const cookie = start.headers.get("Set-Cookie")!.split(";")[0]!;
  const path = `/auth/github/callback?state=${state}&code=test-code`;
  const response = await api(path, undefined, { Cookie: cookie });
  return { response, path, cookie };
}

beforeAll(async () => {
  execFileSync("npm", ["run", "build", "--workspace", "@actions-fleet/relay"], { cwd: root, stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  // Instrument only the in-memory test bundle; production exports no alarm controls.
  const script = readFileSync(`${root}/apps/relay/dist/index.js`, "utf8") + `
const productionFetch = FleetDO.prototype.fetch;
FleetDO.prototype.fetch = async function(request) {
  const url = new URL(request.url);
  if (url.pathname !== "/test/alarm") return productionFetch.call(this, request);
  const next = url.searchParams.get("deadline");
  if (next !== null) await this.state.storage.setAlarm(Number(next));
  return Response.json(await this.state.storage.getAlarm());
};
`;
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  mf = new Miniflare({ ...convertV4MiniflareOptions({ name: "relay-test", modules: true, script, compatibilityDate: "2026-09-18", durableObjects: { FLEET: { className: "FleetDO", useSQLite: true } }, bindings: { OWNER_GITHUB_ID: "2592956", DASHBOARD_ORIGIN: origin, RELAY_PUBLIC_URL: relayUrl, GITHUB_APP_ID: "123", GITHUB_APP_SLUG: "test-app", GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: "test-secret", GITHUB_WEBHOOK_SECRET: secret, MAX_JOB_LOG_BYTES: "2000", MAX_LOG_BYTES: "2500" }, outboundService: async request => {
    const url = new URL(request.url);
    const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (url.href === "https://github.com/login/oauth/access_token") return respond({ access_token: "test-oauth" });
    if (url.hostname !== "api.github.com") throw new Error(`Unexpected upstream host ${url.hostname}`);
    const path = url.pathname;
    if (path === "/user") return respond({ id: oauthUserId, login: "owner", avatar_url: "https://avatars.githubusercontent.com/u/2592956" });
    if (path === "/app/installations") return respond([{ id: 7, suspended_at: null, account: { login: "owner", type: "User" } }]);
    if (path === "/app/installations/7/access_tokens") return respond({ token: "test-installation", expires_at: new Date(Date.now() + 3600000).toISOString() });
    if (path === "/installation/repositories") return respond({ repositories: [repository] });
    if (path.endsWith("/actions/permissions/fork-pr-contributor-approval")) {
      if (request.method === "PUT") approvalPolicy = ((await request.json()) as { approval_policy: string }).approval_policy;
      return respond({ approval_policy: approvalPolicy });
    }
    if (path.endsWith("/collaborators/owner/permission")) return respond({ permission: "admin" });
    if (path.endsWith("/collaborators/outside/permission")) return respond({ permission: "read" });
    if (path.endsWith("/pulls/4")) return respond({ number: 4, user: { login: "outside" }, head: { sha, ref: "main" }, base: { sha: "b".repeat(40), repo: { id: repository.id } } });
    const runMatch = path.match(/^\/repos\/owner\/repo\/actions\/runs\/(\d+)$/);
    if (runMatch) return respond(runs.find(candidate => candidate.id === Number(runMatch[1])));
    const jobMatch = path.match(/^\/repos\/owner\/repo\/actions\/jobs\/(\d+)$/);
    if (jobMatch) return respond(jobs.find(candidate => candidate.id === Number(jobMatch[1])));
    if (path.endsWith("/actions/runners/generate-jitconfig")) {
      jitCalls++;
      const input = await request.json() as { name: string };
      return respond({ runner: { id: 41 }, encoded_jit_config: encode({ ".runner": encode({ agentName: input.name, ephemeral: true }), ".credentials": encode({ test: true }) }) });
    }
    if (path.endsWith("/actions/runners/41") && request.method === "DELETE") return new Response(null, { status: 204 });
    if (["/repos/owner/repo/actions/runs/21/cancel", "/repos/owner/repo/actions/runs/21/force-cancel", "/repos/owner/repo/actions/jobs/31/rerun"].includes(path)) { controls.push(path); return new Response(null, { status: 204 }); }
    if (path.endsWith("/actions/runs")) return respond({ workflow_runs: runs });
    if (path.endsWith("/jobs") && path.includes("/attempts/")) { const runId = Number(path.match(/runs\/(\d+)/)![1]); return respond({ jobs: jobs.filter(candidate => candidate.run_id === runId) }); }
    throw new Error(`Unmocked GitHub API ${request.method} ${path}`);
  } }), unsafeInspectDurableObjects: true });
}, 60000);
afterAll(async () => { await mf?.dispose(); });

describe("durable relay endpoints with GitHub boundary simulated", () => {
  it("requires owner OAuth, one-use state, a real session and exact mutation Origin", async () => {
    expect((await api("/api/overview")).status).toBe(401);
    expect((await api("/api/jobs/31/failure-context")).status).toBe(401);
    expect((await signIn(99)).response.status).toBe(403);
    const login = await signIn();
    expect(login.response.status).toBe(302);
    const setCookie = login.response.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("HttpOnly; Secure; SameSite=Lax");
    sessionCookie = setCookie.match(/fleet_session=[^;,]+/)![0];
    expect((await api(login.path, undefined, { Cookie: login.cookie })).status).toBe(403);
    expect((await api("/api/hosts/enrollment", { name: "Mac" }, { Origin: "https://attacker.example" })).status).toBe(403);
    expect((await api("/api/overview")).status).toBe(200);
  });
  it("consumes enrollment once and starts a host paused", async () => {
    const enrollment = await (await api("/api/hosts/enrollment", { name: "Mac" })).json() as { token: string };
    const input = { ...enrollment, name: "Mac", platform: "darwin", architecture: "arm64", labels: [], version: "0.1.0" };
    const response = await api("/agent/enroll", input);
    expect(response.status).toBe(200);
    const result = await response.json() as { hostId: string; token: string; mode: string };
    hostId = result.hostId; hostToken = result.token;
    expect(result.mode).toBe("paused");
    expect((await api("/agent/enroll", input)).status).toBe(401);
    expect(await (await host("/agent/claim")).json()).toEqual({ lease: null });
  });
  it("exchanges only verified owner CLI credentials with an exact Origin", async () => {
    oauthUserId = 99;
    expect((await api("/auth/cli", {}, { Authorization: "Bearer ghp_testcredential", Cookie: "" })).status).toBe(403);
    oauthUserId = 2592956;
    expect((await api("/auth/cli", {}, { Authorization: "Bearer ghp_testcredential", Origin: "https://wrong.example" })).status).toBe(403);
    const response = await api("/auth/cli", {}, { Authorization: "Bearer ghp_testcredential", Cookie: "" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=3600");
  });
  it("persists admission telemetry and clears it for ready or older agents without changing host mode", async () => {
    const heartbeat = {version:"0.1.0",currentJobId:null,labels:["self-hosted","fleet-macos-arm64"],metrics:{cpuPercent:10,memoryUsedBytes:8e9,memoryTotalBytes:32e9,diskFreeBytes:100e9,loadAverage:1,cpuCount:12}};
    for (const report of [{admissionReason:"Paused on this machine"},{admissionReason:"Shared mode is waiting for lower CPU usage"},{admissionReason:null},{admissionReason:"Paused on this machine"},{}]) {
      expect((await host("/agent/heartbeat", {...heartbeat,...report})).status).toBe(200);
      const overview = await (await api("/api/overview")).json() as Overview;
      const saved = overview.hosts.find(item => item.id === hostId)!;
      expect(saved.admissionReason).toBe("admissionReason" in report ? report.admissionReason : null);
      expect(saved.mode).toBe("paused");
      expect(saved.currentJobId).toBeNull();
    }
  });
  it("enables only an App-selected repository after verifying external approval policy", async () => {
    expect((await api("/api/connections/sync", {})).status).toBe(200);
    expect((await api("/api/repositories/11", { enabled: true })).status).toBe(200);
    expect(approvalPolicy).toBe("all_external_contributors");
    expect((await api("/api/repositories/999", { enabled: true })).status).toBe(409);
  });
  it("rejects invalid webhooks and idempotently upserts signed deliveries", async () => {
    expect((await webhook("bad", wireJob, "sha256=bad")).status).toBe(401);
    expect((await webhook()).status).toBe(202);
    expect((await webhook()).status).toBe(202);
    expect((await webhook("delivery-1", { ...wireJob, name: "changed" })).status).toBe(409);
    const overview = await (await api("/api/overview")).json() as Overview;
    expect(overview.jobs.map(job => job.id)).toEqual(["31"]);
  });
  it("requires a stored job and an operator session for failure context, including empty history", async () => {
    expect((await api("/api/jobs/31/failure-context", undefined, { Cookie: "", Authorization: `Bearer ${hostToken}` })).status).toBe(401);
    expect((await api("/api/jobs/unknown/failure-context")).status).toBe(404);
    const response = await api("/api/jobs/31/failure-context");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ lines: [], notes: ["No retained console records are available for this job. This does not establish whether the job emitted output."] });
  });
  it("atomically reserves one job per host across concurrent claim requests", async () => {
    expect((await api(`/api/hosts/${hostId}/mode`, { mode: "dedicated" })).status).toBe(200);
    const results = await Promise.all([host("/agent/claim"), host("/agent/claim")]);
    const values = await Promise.all(results.map(response => response.json() as Promise<{ lease: Lease | null }>));
    expect(values.filter(result => result.lease)).toHaveLength(1);
    lease = values.find(result => result.lease)!.lease!;
    expect(jitCalls).toBe(1);
    const files = JSON.parse(Buffer.from(lease.encodedJitConfig, "base64").toString());
    expect(JSON.parse(Buffer.from(files[".runner"], "base64").toString()).disableUpdate).toBe(true);
    expect(await (await host("/agent/claim")).json()).toEqual({ lease: null });
  });
  it("requires exact run revision AND GitHub's actual job-to-runner assignment", async () => {
    const input = { leaseId: lease.id, runId: lease.runId, runAttempt: lease.runAttempt, headSha: lease.headSha };
    expect(await (await host("/agent/admission", { ...input, headSha: "b".repeat(40) })).json()).toEqual({ allowed: false });
    expect((await host("/agent/admission", input)).status).toBe(503);
    wireJob.status = "in_progress"; wireJob.started_at = new Date().toISOString(); wireJob.runner_name = "another-runner";
    expect((await host("/agent/admission", input)).status).toBe(503);
    wireJob.runner_name = lease.runnerName;
    expect(await (await host("/agent/admission", input)).json()).toMatchObject({ allowed: true, job: { jobId: "31", headSha: sha, runId: 21, runAttempt: 1, repository: "owner/repo" } });
  });
  it("persists contiguous logs once, rejects conflicting replay, and accepts delayed completion logs", async () => {
    const line: LogLine = { sequence: 1, timestamp: new Date().toISOString(), runId: 21, runAttempt: 1, jobId: "runner-guid", stepId: "step-guid", line: "masked *** output" };
    firstLogLine = line;
    expect(await (await host("/agent/logs", { leaseId: lease.id, lines: [line] })).json()).toEqual({ acknowledgedSequence: 1 });
    expect(await (await host("/agent/logs", { leaseId: lease.id, lines: [line] })).json()).toEqual({ acknowledgedSequence: 1 });
    expect((await host("/agent/logs", { leaseId: lease.id, lines: [{ ...line, line: "different" }] })).status).toBe(409);
    expect((await host("/agent/logs", { leaseId: lease.id, lines: [{ ...line, sequence: 3 }] })).status).toBe(409);
    expect((await host("/agent/logs", { leaseId: lease.id, lines: [{ ...line, sequence: 2, runId: 99 }] })).status).toBe(422);
    expect((await host(`/agent/leases/${lease.id}/complete`, { exitCode: 0 })).status).toBe(200);
    expect(await (await host("/agent/logs", { leaseId: lease.id, lines: [{ ...line, sequence: 2 }] })).json()).toEqual({ acknowledgedSequence: 2 });
    const page = await (await api("/api/jobs/31/logs?after=0")).json() as { lines: LogLine[]; nextCursor: number; truncated: boolean };
    expect(page.lines.map(item => item.jobId)).toEqual(["31", "31"]);
    expect(page.nextCursor).toBe(2); expect(page.truncated).toBe(false);
    const excerpt = await (await api("/api/jobs/31/failure-context")).json() as { lines: LogLine[]; notes: string[] };
    expect(excerpt.lines).toEqual(page.lines);
    expect(excerpt.notes.join(" ")).toContain("No strong error markers");
    const overview = await (await api("/api/overview")).json() as Overview;
    expect(overview.jobs[0]!.conclusion).toBeNull();
    expect(overview.jobs[0]!.status).toBe("in_progress");
  });
  it("acknowledges a batch over the job cap, retaining its newest tail and reporting truncation", async () => {
    const lines = [3, 4, 5].map(sequence => ({ ...firstLogLine, sequence, line: `line ${sequence} ${"x".repeat(1000)}` }));
    expect(await (await host("/agent/logs", { leaseId: lease.id, lines })).json()).toEqual({ acknowledgedSequence: 5 });
    const page = await (await api("/api/jobs/31/logs?after=0")).json() as { lines: LogLine[]; nextCursor: number; truncated: boolean };
    expect(page.lines.map(line => line.sequence)).toEqual([5]);
    expect(page.nextCursor).toBe(5); expect(page.truncated).toBe(true);
    const storage = await mf.unsafeGetDurableObjectStorage("relay-test", "FleetDO", { name: "fleet" });
    const usage = await storage.exec("SELECT bytes FROM log_usage WHERE scope='job:31'");
    expect(Number(usage[0]!.bytes)).toBeLessThanOrEqual(2000);

    // Lease acknowledgment survives history eviction. Replaying it cannot put
    // old output back into the retained tail or move the canonical cursor.
    expect(await (await host("/agent/logs", { leaseId: lease.id, lines: [firstLogLine] })).json()).toEqual({ acknowledgedSequence: 5 });
    const replay = await (await api("/api/jobs/31/logs?after=0")).json() as { lines: LogLine[]; nextCursor: number };
    expect(replay.lines).toEqual(page.lines); expect(replay.nextCursor).toBe(5);
    expect((await host("/agent/logs", { leaseId: lease.id, lines: [{ ...lines[2]!, line: "changed retained output" }] })).status).toBe(409);

    // Even a single line larger than the configured history window cannot
    // strand the local spool; its cumulative cursor still records the gap.
    expect(await (await host("/agent/logs", { leaseId: lease.id, lines: [{ ...firstLogLine, sequence: 6, line: "x".repeat(3000) }] })).json()).toEqual({ acknowledgedSequence: 6 });
    const empty = await (await api("/api/jobs/31/logs?after=5")).json() as { lines: LogLine[]; truncated: boolean };
    expect(empty.lines).toEqual([]); expect(empty.truncated).toBe(true);
    expect(await (await host("/agent/logs", { leaseId: lease.id, lines: [{ ...firstLogLine, sequence: 7, line: "final job output" }] })).json()).toEqual({ acknowledgedSequence: 7 });
    const tail = await (await api("/api/jobs/31/logs?after=5")).json() as { lines: LogLine[]; truncated: boolean };
    expect(tail.lines.map(line => line.sequence)).toEqual([7]); expect(tail.truncated).toBe(true);
  });
  it("uses actual control API scope and does not fabricate completion", async () => {
    expect((await api("/api/jobs/31/control", { action: "cancel" })).status).toBe(200);
    expect((await api("/api/jobs/31/control", { action: "force_cancel" })).status).toBe(200);
    expect((await api("/api/jobs/31/control", { action: "rerun_job" })).status).toBe(200);
    expect(controls).toEqual(["/repos/owner/repo/actions/runs/21/cancel", "/repos/owner/repo/actions/runs/21/force-cancel", "/repos/owner/repo/actions/jobs/31/rerun"]);
    wireJob.status = "completed"; wireJob.conclusion = "failure"; wireJob.completed_at = new Date().toISOString();
    expect((await webhook("finished")).status).toBe(202);
    const overview = await (await api("/api/overview")).json() as Overview;
    expect(overview.jobs[0]!.conclusion).toBe("failure");
  });
  it("safely cross-assigns two hosts to GitHub's actual jobs across different runs", async () => {
    runs.push({ ...run, id: 22, head_sha: "b".repeat(40) });
    const first: typeof wireJob = { ...wireJob, id: 32, status: "queued", runner_name: null, completed_at: null, conclusion: null };
    const second: typeof wireJob = { ...first, id: 33, run_id: 22, head_sha: "b".repeat(40) };
    jobs.push(first, second);
    await webhook("new-first", first); await webhook("new-second", second);
    const enrollment = await (await api("/api/hosts/enrollment", { name: "Second Mac" })).json() as { token: string };
    const secondHost = await (await api("/agent/enroll", { ...enrollment, name: "Second Mac", platform: "darwin", architecture: "arm64", labels: [], version: "0.1.0" })).json() as { hostId: string; token: string };
    await api(`/api/hosts/${secondHost.hostId}/mode`, { mode: "dedicated" });
    const firstLease = (await (await host("/agent/claim")).json() as { lease: Lease }).lease;
    assignedLease = firstLease;
    const secondLease = (await (await api("/agent/claim", {}, { Authorization: `Bearer ${secondHost.token}` })).json() as { lease: Lease }).lease;
    expect(firstLease.jobId).toBe("32"); expect(secondLease.jobId).toBe("33");
    first.status = "in_progress"; first.runner_name = secondLease.runnerName;
    second.status = "in_progress"; second.runner_name = firstLease.runnerName;
    const admitted = await Promise.all([
      host("/agent/admission", { leaseId: firstLease.id, runId: 22, runAttempt: 1, headSha: second.head_sha }),
      api("/agent/admission", { leaseId: secondLease.id, runId: 21, runAttempt: 1, headSha: first.head_sha }, { Authorization: `Bearer ${secondHost.token}` }),
    ]);
    expect(await admitted[0]!.json()).toMatchObject({ allowed: true, job: { jobId: "33", runId: 22, headSha: second.head_sha } });
    expect(await admitted[1]!.json()).toMatchObject({ allowed: true, job: { jobId: "32", runId: 21 } });
    expect(await (await host("/agent/claim")).json()).toEqual({ lease: null });
    const line: LogLine = { sequence: 1, timestamp: new Date().toISOString(), runId: 22, runAttempt: 1, jobId: "actual-guid", stepId: "actual-step", line: "actual assigned job output" };
    expect(await (await host("/agent/logs", { leaseId: firstLease.id, lines: [line] })).json()).toEqual({ acknowledgedSequence: 1 });
    const logs = await (await api("/api/jobs/33/logs")).json() as { lines: LogLine[] };
    expect(logs.lines[0]!.jobId).toBe("33");
    const excerpt = await (await api("/api/jobs/33/failure-context")).json() as { lines: LogLine[] };
    expect(excerpt.lines).toEqual(logs.lines);
    expect(excerpt.lines.every(line => line.jobId === "33")).toBe(true);
  });
  it("evicts the fleet's oldest records across jobs while preserving each lease acknowledgment", async () => {
    expect(await (await host("/agent/logs", { leaseId: lease.id, lines: [{ ...firstLogLine, sequence: 8, line: "a".repeat(1200) }] })).json()).toEqual({ acknowledgedSequence: 8 });
    const next: LogLine = { ...firstLogLine, runId: 22, jobId: "actual-guid", stepId: "actual-step", sequence: 2, line: "b".repeat(1200) };
    expect(await (await host("/agent/logs", { leaseId: assignedLease.id, lines: [next] })).json()).toEqual({ acknowledgedSequence: 2 });
    const old = await (await api("/api/jobs/31/logs")).json() as { lines: LogLine[]; truncated: boolean };
    const newest = await (await api("/api/jobs/33/logs")).json() as { lines: LogLine[]; truncated: boolean };
    expect(old.lines).toEqual([]); expect(old.truncated).toBe(true);
    expect(newest.lines.map(line => line.sequence)).toEqual([2]); expect(newest.truncated).toBe(true);
    expect(await (await host("/agent/logs", { leaseId: lease.id, lines: [firstLogLine] })).json()).toEqual({ acknowledgedSequence: 8 });
    const storage = await mf.unsafeGetDurableObjectStorage("relay-test", "FleetDO", { name: "fleet" });
    const usage = await storage.exec("SELECT bytes FROM log_usage WHERE scope='total'");
    const sum = await storage.exec("SELECT COALESCE(SUM(bytes),0) AS bytes FROM logs");
    expect(Number(usage[0]!.bytes)).toBeLessThanOrEqual(2500);
    expect(usage[0]!.bytes).toBe(sum[0]!.bytes);
  });
  it("provides stable paginated history and individual job details", async () => {
    const first = await (await api("/api/jobs?limit=1")).json() as { items: { id: string }[]; nextCursor: string };
    const second = await (await api(`/api/jobs?limit=1&cursor=${first.nextCursor}`)).json() as { items: { id: string }[] };
    expect(first.items).toHaveLength(1); expect(second.items).toHaveLength(1);
    expect(first.items[0]!.id).not.toBe(second.items[0]!.id);
    expect(await (await api("/api/jobs/31")).json()).toMatchObject({ id: "31", conclusion: "failure" });
    expect((await api("/api/jobs?cursor=invalid")).status).toBe(400);
    expect((await api("/api/audit?limit=1")).status).toBe(200);
  });
  it("requires explicit approval for an outside author and binds that approval to the SHA", async () => {
    const outsideRun = { ...run, id: 23, actor: { id: 90, login: "outside" }, event: "pull_request", pull_requests: [{ number: 4 }] };
    // Test wire type is inferred from the initial empty PR list.
    runs.push(outsideRun as typeof run);
    const outsideJob: typeof wireJob = { ...wireJob, id: 34, run_id: 23, status: "queued", runner_name: null, conclusion: null, completed_at: null };
    jobs.push(outsideJob); await webhook("outside-job", outsideJob);
    const enrollment = await (await api("/api/hosts/enrollment", { name: "Third Mac" })).json() as { token: string };
    const third = await (await api("/agent/enroll", { ...enrollment, name: "Third Mac", platform: "darwin", architecture: "arm64", labels: [], version: "0.1.0" })).json() as { hostId: string; token: string };
    const thirdApi = (path: string, data: unknown = {}) => api(path, data, { Authorization: `Bearer ${third.token}` });
    await api(`/api/hosts/${third.hostId}/mode`, { mode: "dedicated" });
    expect(await (await thirdApi("/agent/claim")).json()).toEqual({ lease: null });
    expect(await (await api("/api/jobs/34")).json()).toMatchObject({ status: "waiting_approval" });
    expect((await api("/api/jobs/34/control", { action: "approve" })).status).toBe(200);
    const reserved = (await (await thirdApi("/agent/claim")).json() as { lease: Lease }).lease;
    expect(reserved.jobId).toBe("34");
    outsideJob.status = "in_progress"; outsideJob.runner_name = reserved.runnerName;
    outsideRun.head_sha = "c".repeat(40); outsideJob.head_sha = outsideRun.head_sha;
    const changed = await thirdApi("/agent/admission", { leaseId: reserved.id, runId: 23, runAttempt: 1, headSha: outsideRun.head_sha });
    expect(await changed.json()).toEqual({ allowed: false });
    outsideRun.head_sha = sha; outsideJob.head_sha = sha;
    expect(await (await thirdApi("/agent/admission", { leaseId: reserved.id, runId: 23, runAttempt: 1, headSha: sha })).json()).toMatchObject({ allowed: true, job: { jobId: "34" } });
  });
  it("accepts a live ticket once and rejects cross-origin connections", async () => {
    const ticket = await (await api("/api/live-ticket", {})).json() as { url: string };
    const socketUrl = ticket.url.replace("wss:", "https:");
    expect((await mf.dispatchFetch(socketUrl, { headers: { Upgrade: "websocket", Origin: "https://wrong.example" } })).status).toBe(403);
    const connected = await mf.dispatchFetch(socketUrl, { headers: { Upgrade: "websocket", Origin: origin } });
    expect(connected.status).toBe(101);
    connected.webSocket!.accept();
    expect((await mf.dispatchFetch(socketUrl, { headers: { Upgrade: "websocket", Origin: origin } })).status).toBe(401);
    connected.webSocket!.close(1000, "test complete");
  });
  it("upgrades an existing pilot schema in place without losing host sessions or logs", async () => {
    const deadline = Date.now() + 120000;
    expect(await (await api(`/test/alarm?deadline=${deadline}`)).json()).toBe(deadline);
    const storage = await mf.unsafeGetDurableObjectStorage("relay-test", "FleetDO", { name: "fleet" });
    const before = await storage.exec("SELECT scope,bytes FROM log_usage ORDER BY scope");
    await storage.exec("ALTER TABLE approvals DROP COLUMN revision");
    await storage.exec("ALTER TABLE leases DROP COLUMN execution_sha");
    await mf.unsafeEvictDurableObject("relay-test", "FleetDO", { name: "fleet", webSockets: "close" });
    expect((await api("/api/overview")).status).toBe(200);
    expect(await (await api("/test/alarm")).json()).toBe(deadline);
    const upgraded = await mf.unsafeGetDurableObjectStorage("relay-test", "FleetDO", { name: "fleet" });
    expect((await upgraded.exec("PRAGMA table_info(approvals)")).some(column => column.name === "revision")).toBe(true);
    expect((await upgraded.exec("PRAGMA table_info(leases)")).some(column => column.name === "execution_sha")).toBe(true);
    expect(await upgraded.exec("SELECT scope,bytes FROM log_usage ORDER BY scope")).toEqual(before);
    expect((await upgraded.exec("SELECT COUNT(*) AS n FROM hosts"))[0]!.n).toBe(3);
    expect((await (await api("/api/jobs/33/logs")).json() as { lines: LogLine[] }).lines.map(line => line.sequence)).toEqual([2]);
    expect((await upgraded.exec("SELECT revision FROM approvals"))[0]!.revision).toBe("");
  });
  it("invalidates sessions and enrollment authority on logout", async () => {
    expect((await api("/api/logout", {})).status).toBe(200);
    expect((await api("/api/overview")).status).toBe(401);
    expect((await api("/api/hosts/enrollment", { name: "No" })).status).toBe(401);
  });
});
