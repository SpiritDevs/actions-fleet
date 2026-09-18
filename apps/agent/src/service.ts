import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentConfiguration, HostMetrics, HostMode, Lease } from "@actions-fleet/protocol";
import { admissionReason } from "./admission.js";
import { ApiClient, RelayError, type RelayClient } from "./api.js";
import { isMissing, privateDirectory, readJson, writeJson } from "./files.js";
import { HostLock } from "./lock.js";
import { MetricsCollector } from "./metrics.js";
import { cleanupRunner, prepareRunner, startRunner, validateRunnerTemplate, type ActiveRunner } from "./runner.js";
import { leaseKey, LogSpool, quarantinedSpoolCount, restoreSpools, spoolDiskBytes } from "./spool.js";

export interface PublicStatus {
  schemaVersion: 1; hostId: string; name: string; pid: number;
  connectionStatus: "connected" | "disconnected" | "revoked" | "stopped";
  mode: HostMode; localModeOverride: "paused" | null; effectiveMode: HostMode;
  currentJob: {id: string; runId: number; runAttempt: number; repository: string; htmlUrl: string} | null;
  metrics: HostMetrics; updatedAt: string; error?: string; admissionReason?: string;
}

export class HostService {
  private readonly api: RelayClient;
  private readonly lock: HostLock;
  private readonly collector = new MetricsCollector();
  private readonly spoolRoot: string;
  private mode: HostMode = "paused";
  private locallyPaused = false;
  private healthy = false;
  private revoked = false;
  private draining = false;
  private active: ActiveRunner | null = null;
  private spools: LogSpool[] = [];
  private metrics!: HostMetrics;
  private diskBytes = 0;
  private quarantineCount = 0;
  private error: string | undefined;
  private lastHeartbeat = 0;
  private lastHeartbeatAttempt = 0;
  private lastClaim = 0;
  private lastUpload = 0;
  private lastStatus = 0;
  private hookInFlight = false;
  constructor(private readonly config: AgentConfiguration, private readonly entrypoint: string, api?: RelayClient, lock?: HostLock) {
    this.api = api ?? new ApiClient(config);
    this.lock = lock ?? new HostLock(config.stateDirectory);
    this.spoolRoot = join(config.stateDirectory,"spool");
  }

  drain(): void { this.draining = true; }

  private reason(): string | null {
    if (this.revoked) return "Host identity has been revoked";
    if (this.spools.length && !this.active) return "Replaying logs and reconciling the previous runner";
    return admissionReason({mode:this.mode,locallyPaused:this.locallyPaused,relayHealthy:this.healthy && Date.now()-this.lastHeartbeat < 20_000,active:!!this.active,draining:this.draining,metrics:this.metrics,sharedMaxCpuPercent:this.config.sharedMaxCpuPercent,sharedMinFreeMemoryBytes:this.config.sharedMinFreeMemoryBytes,spoolAvailableBytes:this.config.maxSpoolBytes-this.diskBytes});
  }
  private relayFailed(error: unknown): void {
    this.healthy = false;
    if (error instanceof RelayError && error.status === 401) this.revoked = true;
    this.error = this.revoked ? "Host credentials were rejected; re-enrollment is required" : "Relay connection failed; active work may finish while new admission is paused";
  }

  private async readControl(): Promise<void> {
    try {
      const control = await readJson<{paused:unknown}>(join(this.config.stateDirectory,"control.json"));
      if (typeof control.paused !== "boolean") throw new Error("Invalid local control file");
      this.locallyPaused = control.paused;
    } catch(error) {
      if (isMissing(error)) this.locallyPaused = false;
      else {this.locallyPaused = true;this.error = "Local control file is invalid; admission is paused";}
    }
  }

  private async status(stopped = false): Promise<void> {
    const lease = this.active?.lease;
    const reason = this.reason();
    const degraded = this.spools.find(spool => spool.degraded)?.degraded ?? (this.quarantineCount ? `${this.quarantineCount} log spool(s) need local review; rejected data is retained on disk` : undefined);
    const status: PublicStatus = {
      schemaVersion:1,hostId:this.config.hostId,name:this.config.name,pid:process.pid,
      connectionStatus:stopped ? "stopped" : this.revoked ? "revoked" : this.healthy ? "connected" : "disconnected",
      mode:this.mode,localModeOverride:this.locallyPaused ? "paused" : null,effectiveMode:this.locallyPaused ? "paused" : this.mode,
      currentJob:lease ? {id:lease.jobId,runId:lease.runId,runAttempt:lease.runAttempt,repository:lease.repository,htmlUrl:`https://github.com/${lease.repository}/actions/runs/${lease.runId}/attempts/${lease.runAttempt}`} : null,
      metrics:this.metrics,updatedAt:new Date().toISOString(),
      ...(degraded || this.error ? {error:degraded ?? this.error} : {}),...(reason ? {admissionReason:reason} : {}),
    };
    await writeJson(join(this.config.stateDirectory,"status.json"),status);
  }

  async run(): Promise<void> {
    await privateDirectory(this.config.stateDirectory);
    await validateRunnerTemplate(this.config.runnerDirectory);
    await this.lock.acquire((req,res) => {void this.handleHook(req,res).catch(() => {if (!res.headersSent) res.writeHead(503);res.end();});});
    try {
      this.metrics = await this.collector.sample(this.config.stateDirectory);
      this.spools = await restoreSpools(this.spoolRoot);
      this.quarantineCount = await quarantinedSpoolCount(this.spoolRoot);
      for (const spool of this.spools) {
        // The host lock has already rejected a surviving helper. A lease is
        // never started twice, even if its prior outcome cannot be recovered.
        if (!await spool.result()) await writeJson(spool.resultPath,{exitCode:-1,error:"Agent restarted before runner completion could be confirmed",completedAt:new Date().toISOString()});
      }
      const onSignal = (): void => this.drain();
      process.on("SIGTERM",onSignal); process.on("SIGINT",onSignal);
      try {
        await this.status();
        while (!this.draining || this.active) {
          await this.tick();
          await delay(250);
        }
        // Preserve any unacknowledged spool for the next start during outages.
        for (const spool of this.spools) if (spool.admitted) await spool.ingest(true);
        await this.status(true);
      } finally {process.off("SIGTERM",onSignal);process.off("SIGINT",onSignal);}
    } finally {await this.lock.release();}
  }

  private async tick(): Promise<void> {
    await this.readControl();
    for (const spool of this.spools) if (spool.admitted) await spool.ingest(!this.active || this.active.spool !== spool || this.active.closed);
    if (this.active?.closed) {
      const finished = this.active;
      if (!await finished.spool.result()) await writeJson(finished.spool.resultPath,{exitCode:finished.exitCode ?? -1,error:"Runner supervisor exited without a completion receipt",completedAt:new Date().toISOString()});
      await this.lock.clearChild();
      this.active = null;
      await this.status();
    }
    const now = Date.now();
    if (now - this.lastHeartbeatAttempt >= 5000 && !this.revoked) {
      this.lastHeartbeatAttempt = now;
      this.metrics = await this.collector.sample(this.config.stateDirectory);
      try {
        const result = await this.api.heartbeat(this.metrics,this.active?.lease.jobId ?? null,this.reason());
        this.mode = result.mode; this.revoked = !!result.revoked;
        this.healthy = !this.revoked; this.lastHeartbeat = Date.now();
        if (this.healthy) this.error = undefined;
      } catch(error) {this.relayFailed(error);}
    }
    if (now-this.lastUpload >= 1000 && this.healthy && !this.revoked) {
      this.lastUpload = now;
      for (const spool of [...this.spools]) {
        try {
          const result = await spool.result();
          if (result && !spool.completionAcknowledged) {
            await this.api.complete(spool.lease.id,result.exitCode,result.error ?? spool.degraded);
            await spool.markCompleted();
          }
          if (result && !spool.admitted) {
            await this.quarantine(spool,"Runner did not pass authoritative admission; unassigned diagnostics retained locally");
            continue;
          }
          if (result && spool.hasUnidentifiedGap && await spool.fullyIngested()) {
            await this.quarantine(spool,"No runner job identity could be recovered for collector diagnostics");
            continue;
          }
          const lines = spool.batch();
          if (lines.length) await spool.acknowledge(await this.api.upload(spool.lease.id,lines),lines.at(-1)!.sequence);
          if (result && await spool.fullyIngested()) await cleanupRunner(this.config.stateDirectory,spool.jobDirectory,spool.lease.id);
          if (await spool.removeIfFinished()) this.spools = this.spools.filter(item => item !== spool);
        } catch(error) {
          if (error instanceof RelayError && error.status === 422 && await spool.result()) {
            await this.quarantine(spool,"Relay rejected the runner log identity; data retained for operator review");
          } else if (error instanceof RelayError && error.status === 409) {
            // GitHub's runner assignment may arrive after the first setup log.
          } else {this.relayFailed(error);break;}
        }
      }
    }
    this.diskBytes = await spoolDiskBytes(this.spoolRoot);
    if (Date.now()-this.lastClaim >= 3000 && !this.reason()) {
      this.lastClaim = Date.now();
      try {
        const lease = await this.api.claim();
        if (lease) await this.launch(lease);
      } catch(error) {this.relayFailed(error);}
    }
    if (Date.now()-this.lastStatus >= 1000) {this.lastStatus = Date.now();await this.status();}
  }

  private async quarantine(spool: LogSpool, reason: string): Promise<void> {
    await spool.quarantine(reason);
    await cleanupRunner(this.config.stateDirectory,spool.jobDirectory,spool.lease.id);
    this.spools = this.spools.filter(item => item !== spool);
    this.quarantineCount += 1;
    this.error = reason;
  }

  private async launch(lease: Lease): Promise<void> {
    let spool: LogSpool | undefined;
    try {
      const directory = join(this.config.stateDirectory,"jobs",leaseKey(lease.id));
      spool = await LogSpool.create(this.spoolRoot,lease,directory,this.config.maxSpoolBytes-this.diskBytes);
      this.spools.push(spool);
      if (Date.parse(lease.expiresAt) <= Date.now()) throw new Error("Registration lease has expired");
      await this.readControl();
      if (this.draining || this.locallyPaused || this.mode === "paused" || !this.healthy || this.revoked) throw new Error("Host admission changed while claiming work");
      await prepareRunner(this.config,lease);
      this.active = await startRunner(this.config,lease,spool,this.mode,this.lock,this.entrypoint);
      await this.status();
    } catch {
      const error = "Host could not prepare or start the one-job runner";
      if (spool) await writeJson(spool.resultPath,{exitCode:-1,error,completedAt:new Date().toISOString()});
      else await this.api.complete(lease.id,-1,error);
      this.error = error;
    }
  }

  private async handleHook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Content-Type","application/json");
    const reject = (code: number): void => {res.writeHead(code);res.end('{"allowed":false}');};
    if (req.method !== "POST" || req.url !== "/admission" || req.headers.origin) return reject(404);
    const active = this.active;
    const presented = req.headers.authorization?.replace(/^Bearer /,"") ?? "";
    const expected = active?.capability ?? "";
    if (!active || !expected || Buffer.byteLength(presented) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(presented),Buffer.from(expected))) return reject(403);
    if (this.hookInFlight || active.admitted || active.closed) return reject(409);
    this.hookInFlight = true;
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 4096) return reject(413);
        chunks.push(Buffer.from(chunk));
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {runId?:unknown;runAttempt?:unknown;headSha?:unknown};
      if (!Number.isSafeInteger(input.runId) || (input.runId as number) <= 0 || !Number.isSafeInteger(input.runAttempt) || (input.runAttempt as number) <= 0 || typeof input.headSha !== "string" || !/^[a-f0-9]{40,64}$/i.test(input.headSha)) return reject(403);
      await this.readControl();
      if (this.draining || this.locallyPaused || this.mode === "paused" || this.revoked) return reject(403);
      if (!this.healthy || Date.now()-this.lastHeartbeat >= 20_000) return reject(503);
      let job;
      try { job = await this.api.admission(active.lease.id,{runId:input.runId as number,runAttempt:input.runAttempt as number,headSha:input.headSha}); } catch(error) {this.relayFailed(error);return reject(503);}
      if (!job || job.runId !== input.runId || job.runAttempt !== input.runAttempt || job.headSha !== input.headSha) return reject(403);
      await active.spool.bindAdmission(job);
      active.lease = {...active.lease,...job};
      active.admitted = true;
      res.writeHead(200);res.end('{"allowed":true}');
    } finally {this.hookInFlight = false;}
  }
}

export async function admissionHook(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const endpoint = environment.FLEET_HOOK_URL;
  const capability = environment.FLEET_HOOK_CAPABILITY;
  if (!endpoint || !capability) throw new Error("Missing local admission capability");
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/admission" || url.username || url.password) throw new Error("Invalid local admission endpoint");
  const runId = Number(environment.GITHUB_RUN_ID), runAttempt = Number(environment.GITHUB_RUN_ATTEMPT), headSha = environment.GITHUB_SHA;
  if (!Number.isSafeInteger(runId) || runId <= 0 || !Number.isSafeInteger(runAttempt) || runAttempt <= 0 || !headSha) throw new Error("Runner did not supply an identifiable workflow attempt");
  const deadline = Date.now()+60_000;
  while (Date.now()<deadline) {
    let response: Response | undefined;
    try {
      response = await fetch(url,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${capability}`},body:JSON.stringify({runId,runAttempt,headSha}),signal:AbortSignal.timeout(Math.min(18_000,deadline-Date.now())),redirect:"error"});
    } catch { /* A transient local/relay connection failure remains fail closed. */ }
    if (response?.ok) {
      if ((await response.json() as {allowed?:boolean}).allowed === true) return;
      throw new Error("Fleet admission denied this job before workflow steps");
    }
    if (response && response.status !== 503 && response.status !== 409) throw new Error("Fleet admission denied this job before workflow steps");
    if (Date.now()<deadline) await delay(Math.min(1000,deadline-Date.now()));
  }
  throw new Error("Fleet admission could not be verified within 60 seconds; workflow steps are blocked");
}
