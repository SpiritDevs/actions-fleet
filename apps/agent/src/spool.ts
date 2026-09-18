import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rm, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { logLineSchema, type Lease, type LogLine } from "@actions-fleet/protocol";
import { atomicWrite, isMissing, privateDirectory, readJson, writeJson } from "./files.js";
import type { AdmittedJob } from "./api.js";

const rawSchema = logLineSchema.omit({sequence: true});
const GAP_RESERVE = 4096;
export const MIN_LEASE_BUDGET = 1024 * 1024;
export type SafeLease = Omit<Lease, "encodedJitConfig">;
export interface RunnerResult { exitCode: number; error?: string; completedAt: string }
interface Manifest {version: 1; lease: SafeLease; sourceLimit: number; eventLimit: number; jobDirectory: string; completionAcknowledged?: boolean; admitted?: boolean}
interface SpoolState {
  version: 1; nextSequence: number; acknowledgedSequence: number; sourceOffset: number;
  pendingGap?: {count: number; bytes: number; reason: string};
  collectorError?: string; errorSentinelSeen?: boolean; runnerJobId?: string; missingCaptureSeen?: boolean;
}
interface EventRecord { line: LogLine; sourceEnd: number }

export function leaseKey(id: string): string { return createHash("sha256").update(id).digest("hex"); }

export class LogSpool {
  readonly sourcePath: string;
  readonly resultPath: string;
  private events: EventRecord[] = [];
  private bytes = 0;
  private state: SpoolState = {version: 1, nextSequence: 1, acknowledgedSequence: 0, sourceOffset: 0};
  private constructor(readonly directory: string, readonly manifest: Manifest) {
    this.sourcePath = join(directory, "source.ndjson");
    this.resultPath = join(directory, "result.json");
  }
  get lease(): SafeLease { return this.manifest.lease; }
  get degraded(): string | undefined { return this.state.collectorError; }
  get pending(): boolean { return this.events.length > 0 || !!this.state.pendingGap; }
  get completionAcknowledged(): boolean { return !!this.manifest.completionAcknowledged; }
  get admitted(): boolean { return !!this.manifest.admitted; }
  get hasUnidentifiedGap(): boolean { return !!this.state.pendingGap && !this.state.runnerJobId; }
  get jobDirectory(): string { return this.manifest.jobDirectory; }
  get sourceLimit(): number { return this.manifest.sourceLimit; }
  async bindAdmission(job: AdmittedJob): Promise<void> {
    if (this.events.length || this.state.sourceOffset || this.manifest.admitted) throw new Error("Cannot change the identity of an already sequenced lease");
    if (job.repository !== this.lease.repository) throw new Error("Relay admission changed the scoped repository");
    const manifest = {...this.manifest,lease:{...this.manifest.lease,...job},admitted:true};
    await writeJson(join(this.directory,"manifest.json"),manifest);
    Object.assign(this.manifest,manifest);
  }

  static async create(root: string, lease: Lease, jobDirectory: string, availableBytes: number): Promise<LogSpool> {
    if (availableBytes < MIN_LEASE_BUDGET) throw new Error("Insufficient durable log spool capacity");
    const directory = join(root, leaseKey(lease.id));
    await privateDirectory(root);
    await mkdir(directory,{mode:0o700}); // Existing leases must never be restarted or overwritten.
    // Raw capture cannot rotate while Runner.Worker owns its file handle. Reserve it
    // independently from the sequenced replay queue and leave room for metadata.
    // The third share reserves the atomic replacement file used by compaction.
    const sourceLimit = Math.min(64 * 1024 * 1024, Math.floor((availableBytes - 64 * 1024) / 3));
    const eventLimit = Math.min(32 * 1024 * 1024, Math.floor((availableBytes - 64 * 1024) / 3));
    const {encodedJitConfig: _secret, ...safeLease} = lease;
    const spool = new LogSpool(directory, {version: 1, lease: safeLease, sourceLimit, eventLimit, jobDirectory});
    await writeJson(join(directory, "manifest.json"), spool.manifest);
    await spool.persistState();
    return spool;
  }

  static async restore(directory: string): Promise<LogSpool> {
    await privateDirectory(directory);
    const manifest = await readJson<Manifest>(join(directory, "manifest.json"));
    if (manifest.version !== 1 || manifest.eventLimit > 32 * 1024 * 1024 || manifest.eventLimit < GAP_RESERVE || leaseKey(manifest.lease.id) !== directory.split("/").at(-1)) throw new Error("Invalid spool manifest");
    const spool = new LogSpool(directory, manifest);
    spool.state = await readJson<SpoolState>(join(directory, "state.json"));
    if (spool.state.version !== 1 || !Number.isSafeInteger(spool.state.nextSequence) || spool.state.nextSequence < 1 || !Number.isSafeInteger(spool.state.acknowledgedSequence) || spool.state.acknowledgedSequence < 0 || !Number.isSafeInteger(spool.state.sourceOffset) || spool.state.sourceOffset < 0) throw new Error("Invalid spool state");
    let contents: Buffer;
    try { contents = await readFile(join(directory, "events.ndjson")); } catch(error) { if (!isMissing(error)) throw error; contents = Buffer.alloc(0); }
    const completeLength = contents.lastIndexOf(10) + 1;
    if (completeLength < contents.length) await truncate(join(directory, "events.ndjson"), completeLength);
    let last = 0;
    for (const value of contents.subarray(0,completeLength).toString("utf8").split("\n")) {
      if (!value) continue;
      const record = JSON.parse(value) as EventRecord;
      record.line = logLineSchema.parse(record.line);
      if (record.line.runId !== manifest.lease.runId || record.line.runAttempt !== manifest.lease.runAttempt) throw new Error("Spool event does not match the admitted workflow attempt");
      if (!Number.isSafeInteger(record.sourceEnd) || record.sourceEnd < 0 || record.line.sequence <= last) throw new Error("Corrupt log replay sequence");
      last = record.line.sequence;
      spool.state.runnerJobId ??= record.line.jobId;
      spool.state.nextSequence = Math.max(spool.state.nextSequence, last + 1);
      spool.state.sourceOffset = Math.max(spool.state.sourceOffset, record.sourceEnd);
      if (last > spool.state.acknowledgedSequence) spool.events.push(record);
    }
    // A crash between appending an event and advancing the cursor is recoverable
    // from sourceEnd in the durable event itself.
    await spool.compact();
    await spool.persistState();
    return spool;
  }

  private persistState(): Promise<void> { return writeJson(join(this.directory,"state.json"), this.state); }
  private async compact(): Promise<void> {
    const text = this.events.map(row => `${JSON.stringify(row)}\n`).join("");
    await atomicWrite(join(this.directory,"events.ndjson"),text);
    this.bytes = Buffer.byteLength(text);
  }
  private metadata(line: string): Omit<LogLine,"sequence"> {
    return {timestamp: new Date().toISOString(), runId: this.lease.runId, runAttempt: this.lease.runAttempt, jobId: this.state.runnerJobId!, stepId:"",line};
  }
  private async append(line: Omit<LogLine,"sequence">, sourceEnd: number, reserve = true): Promise<boolean> {
    const record: EventRecord = {line: {...line,sequence: this.state.nextSequence},sourceEnd};
    const text = `${JSON.stringify(record)}\n`, bytes = Buffer.byteLength(text);
    if (this.bytes + bytes > this.manifest.eventLimit - (reserve ? GAP_RESERVE : 0)) return false;
    const handle = await open(join(this.directory,"events.ndjson"),"a",0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    this.events.push(record);
    this.bytes += bytes;
    this.state.nextSequence += 1;
    this.state.sourceOffset = Math.max(this.state.sourceOffset,sourceEnd);
    return true;
  }
  private async flushGap(): Promise<boolean> {
    const gap = this.state.pendingGap;
    if (!gap) return true;
    if (!this.state.runnerJobId) return false;
    if (!await this.append(this.metadata(`[fleet log gap: ${gap.count} record(s), ${gap.bytes} byte(s) omitted; ${gap.reason}]`),this.state.sourceOffset,false)) return false;
    delete this.state.pendingGap;
    await this.persistState();
    return true;
  }
  private async drop(bytes: number, sourceEnd: number, reason: string): Promise<void> {
    const previous = this.state.pendingGap;
    this.state.pendingGap = {count:(previous?.count ?? 0)+1,bytes:(previous?.bytes ?? 0)+bytes,reason:previous?.reason ?? reason};
    this.state.collectorError = reason;
    this.state.sourceOffset = sourceEnd;
    await this.persistState();
  }

  async ingest(final = false): Promise<void> {
    if (!this.state.errorSentinelSeen) {
      try {
        await stat(`${this.sourcePath}.error`);
        this.state.errorSentinelSeen = true;
        await this.drop(0,this.state.sourceOffset,"Runner log exporter reported an I/O failure");
      } catch(error) { if (!isMissing(error)) throw error; }
    }
    let handle;
    try { handle = await open(this.sourcePath,"r"); } catch(error) {
      if (isMissing(error)) {if (final) await this.missingCapture();await this.flushGap();return;}
      throw error;
    }
    try {
      const sourceSize = (await handle.stat()).size;
      if (sourceSize < this.state.sourceOffset) throw new Error("Runner log file was truncated unexpectedly");
      const length = Math.min(sourceSize - this.state.sourceOffset, 1024 * 1024);
      if (!length) {if (final && !sourceSize) await this.missingCapture();await this.flushGap();return;}
      const data = Buffer.alloc(length);
      const {bytesRead} = await handle.read(data,0,length,this.state.sourceOffset);
      const base = this.state.sourceOffset;
      let start = 0;
      for (let end = data.indexOf(10,0); end >= 0 && end < bytesRead; end = data.indexOf(10,start)) {
        const raw = data.subarray(start,end), sourceEnd = base+end+1;
        let line: Omit<LogLine,"sequence"> | undefined;
        try {
          line = rawSchema.parse(JSON.parse(raw.toString("utf8")));
          if (line.runId !== this.lease.runId || line.runAttempt !== this.lease.runAttempt) line = undefined;
          if (line && this.state.runnerJobId && line.jobId !== this.state.runnerJobId) line = undefined;
          if (line) this.state.runnerJobId ??= line.jobId;
        } catch { /* Malformed output becomes an explicit gap below. */ }
        if (!line) await this.drop(raw.length,sourceEnd,"Invalid runner export record or run identity");
        else if (!await this.flushGap() || !await this.append(line,sourceEnd)) await this.drop(raw.length,sourceEnd,"Local replay queue reached its configured limit");
        else {
          if (line.line.startsWith("[fleet log gap:")) this.state.collectorError = "Runner capture reached its configured limit; full output remains in GitHub Actions";
          await this.persistState();
        }
        start = end+1;
      }
      if (start === 0 && bytesRead === 1024 * 1024) {
        // A valid exporter record is <300 KiB. Never buffer an unbounded line.
        await this.drop(bytesRead,base+bytesRead,"Runner export record exceeded the allowed size");
      } else if (final && base+bytesRead === sourceSize && start < bytesRead) {
        await this.drop(bytesRead-start,base+bytesRead,"Runner stopped with an incomplete export record");
      }
      await this.flushGap();
    } finally { await handle.close(); }
  }

  private async missingCapture(): Promise<void> {
    if (this.state.missingCaptureSeen || !this.admitted) return;
    this.state.missingCaptureSeen = true;
    await this.drop(0,this.state.sourceOffset,"No masked runner capture was produced for the admitted job");
  }

  batch(maxBytes = 256 * 1024): LogLine[] {
    const lines: LogLine[] = []; let bytes = 0;
    for (const event of this.events) {
      const size = Buffer.byteLength(JSON.stringify(event.line));
      if (lines.length && (lines.length >= 100 || bytes+size > maxBytes)) break;
      lines.push(event.line); bytes += size;
    }
    return lines;
  }
  async acknowledge(sequence: number, lastSent: number): Promise<void> {
    if (!Number.isSafeInteger(sequence) || sequence < this.state.acknowledgedSequence || sequence > lastSent) throw new Error("Relay acknowledged a sequence outside the uploaded range");
    this.state.acknowledgedSequence = sequence;
    // Persist acknowledgement before compaction: interrupted compaction may only
    // cause an idempotent retry, never reuse a sequence number.
    await this.persistState();
    this.events = this.events.filter(event => event.line.sequence > sequence);
    await this.compact();
    await this.flushGap();
  }
  async result(): Promise<RunnerResult | null> {
    try { return await readJson<RunnerResult>(this.resultPath); } catch(error) { if (isMissing(error)) return null; throw error; }
  }
  async markCompleted(): Promise<void> { this.manifest.completionAcknowledged = true; await writeJson(join(this.directory,"manifest.json"),this.manifest); }
  async quarantine(reason: string): Promise<void> {
    await writeJson(join(this.directory,"quarantine.json"),{reason,createdAt:new Date().toISOString()});
  }
  async fullyIngested(): Promise<boolean> {
    try { return this.state.sourceOffset === (await stat(this.sourcePath)).size; } catch(error) { if (isMissing(error)) return true; throw error; }
  }
  async removeIfFinished(): Promise<boolean> {
    if (!this.completionAcknowledged || this.pending || !await this.fullyIngested()) return false;
    await rm(this.directory,{recursive:true,force:true});
    return true;
  }
}

export async function restoreSpools(root: string): Promise<LogSpool[]> {
  await privateDirectory(root);
  const result: LogSpool[] = [];
  for (const item of await readdir(root,{withFileTypes:true})) {
    if (item.isDirectory() && /^[a-f0-9]{64}$/.test(item.name)) {
      try {await stat(join(root,item.name,"quarantine.json"));continue;} catch(error) {if (!isMissing(error)) throw error;}
      result.push(await LogSpool.restore(join(root,item.name)));
    }
  }
  return result;
}

export async function quarantinedSpoolCount(root: string): Promise<number> {
  let count = 0;
  for (const item of await readdir(root,{withFileTypes:true})) {
    if (!item.isDirectory() || !/^[a-f0-9]{64}$/.test(item.name)) continue;
    try {await stat(join(root,item.name,"quarantine.json"));count++;} catch(error) {if (!isMissing(error)) throw error;}
  }
  return count;
}

export async function spoolDiskBytes(root: string): Promise<number> {
  let sum = 0;
  for (const item of await readdir(root,{withFileTypes:true})) {
    if (!item.isDirectory() || !/^[a-f0-9]{64}$/.test(item.name)) continue;
    for (const file of await readdir(join(root,item.name),{withFileTypes:true})) {
      if (file.isFile()) sum += (await stat(join(root,item.name,file.name))).size;
    }
  }
  return sum;
}
