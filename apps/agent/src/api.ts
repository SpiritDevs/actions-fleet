import { z } from "zod";
import { hostModeSchema, type AgentConfiguration, type HostMetrics, type HostMode, type Lease, type LogLine } from "@actions-fleet/protocol";
import { VERSION } from "./config.js";

const leaseSchema = z.object({
  id: z.string().min(1).max(128), jobId: z.string().min(1).max(128), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  runId: z.number().int().positive(), runAttempt: z.number().int().positive(), headSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  runnerName: z.string().min(1).max(128), encodedJitConfig: z.string().min(1).max(1024 * 1024), expiresAt: z.string().datetime(),
});

export class RelayError extends Error {
  constructor(public readonly status: number) { super(`Relay request failed (HTTP ${status})`); }
}

export async function request(relayUrl: string, path: string, body: unknown, token?: string): Promise<unknown> {
  const response = await fetch(`${relayUrl}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000), redirect: "error",
  });
  if (!response.ok) throw new RelayError(response.status);
  if (!response.body) throw new Error("Relay returned an empty response");
  const chunks: Uint8Array[] = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > 2 * 1024 * 1024) throw new Error("Relay response exceeds the allowed size");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function enroll(relay: string, input: { token: string; name: string; platform: "darwin" | "linux"; architecture: "arm64" | "x64"; labels: string[] }): Promise<{hostId: string; token: string; mode: HostMode}> {
  return z.object({ hostId: z.string().min(1), token: z.string().min(20), mode: hostModeSchema }).parse(await request(relay, "/agent/enroll", { ...input, version: VERSION }));
}

export interface RelayClient {
  heartbeat(metrics: HostMetrics, currentJobId: string | null): Promise<{mode: HostMode; revoked?: boolean}>;
  claim(): Promise<Lease | null>;
  admission(leaseId: string, input: {runId: number; runAttempt: number; headSha: string}): Promise<AdmittedJob | null>;
  upload(leaseId: string, lines: LogLine[]): Promise<number>;
  complete(leaseId: string, exitCode: number, error?: string): Promise<void>;
}
export type AdmittedJob = Pick<Lease,"jobId"|"repository"|"runId"|"runAttempt"|"headSha">;

export class ApiClient implements RelayClient {
  constructor(private readonly configuration: AgentConfiguration) {}
  private call(path: string, body: unknown): Promise<unknown> { return request(this.configuration.relayUrl, path, body, this.configuration.token); }
  async heartbeat(metrics: HostMetrics, currentJobId: string | null): Promise<{mode: HostMode; revoked?: boolean}> {
    return z.object({ mode: hostModeSchema, revoked: z.boolean().optional() }).parse(await this.call("/agent/heartbeat", { version: VERSION, metrics, currentJobId, labels: this.configuration.labels }));
  }
  async claim(): Promise<Lease | null> { return z.object({lease: leaseSchema.nullable()}).parse(await this.call("/agent/claim", {})).lease; }
  async admission(leaseId: string, input: {runId: number; runAttempt: number; headSha: string}): Promise<AdmittedJob | null> {
    const response = z.discriminatedUnion("allowed",[
      z.object({allowed:z.literal(false)}),
      z.object({allowed:z.literal(true),job:leaseSchema.pick({jobId:true,repository:true,runId:true,runAttempt:true,headSha:true})}),
    ]).parse(await this.call("/agent/admission", {leaseId,...input}));
    return response.allowed ? response.job : null;
  }
  async upload(leaseId: string, lines: LogLine[]): Promise<number> {
    return z.object({ acknowledgedSequence: z.number().int().nonnegative() }).parse(await this.call("/agent/logs", {leaseId, lines})).acknowledgedSequence;
  }
  async complete(leaseId: string, exitCode: number, error?: string): Promise<void> {
    z.object({ ok: z.literal(true) }).parse(await this.call(`/agent/leases/${encodeURIComponent(leaseId)}/complete`, {exitCode, ...(error ? {error} : {})}));
  }
}
