import { z } from "zod";

export const hostModeSchema = z.enum(["dedicated", "shared", "paused"]);
export type HostMode = z.infer<typeof hostModeSchema>;
export const platformSchema = z.enum(["darwin", "linux"]);
export const architectureSchema = z.enum(["arm64", "x64"]);
export const hostMetricsSchema = z.object({
  cpuPercent: z.number().min(0).max(100), memoryUsedBytes: z.number().nonnegative(),
  memoryTotalBytes: z.number().positive(), diskFreeBytes: z.number().nonnegative(),
  memoryAvailableBytes: z.number().nonnegative().optional(),
  loadAverage: z.number().nonnegative(), cpuCount: z.number().int().positive(),
});
export type HostMetrics = z.infer<typeof hostMetricsSchema>;
export interface Host {
  id: string; name: string; platform: "darwin" | "linux"; architecture: "arm64" | "x64";
  mode: HostMode; status: "online" | "offline" | "busy"; labels: string[];
  lastSeenAt: string; enrolledAt: string; metrics: HostMetrics | null;
  currentJobId: string | null; version: string; admissionReason?: string | null;
}
export interface Repository {
  id: number; installationId: number; owner: string; name: string; fullName: string;
  private: boolean; enabled: boolean; approvalPolicy: "all_external_contributors";
}
export interface Connection { id: number; account: string; accountType: string; repositoryCount: number }
export interface Job {
  id: string; runId: number; runAttempt: number; repository: string; installationId: number;
  workflowName: string; name: string; branch: string; headSha: string; actor: string;
  status: "queued" | "in_progress" | "completed" | "waiting_approval";
  conclusion: string | null; labels: string[]; hostId: string | null;
  runnerName: string | null; createdAt: string; startedAt: string | null;
  completedAt: string | null; htmlUrl: string; steps: JobStep[];
}
export interface JobStep { number: number; name: string; status: string; conclusion: string | null }
export const logLineSchema = z.object({
  sequence: z.number().int().positive(), timestamp: z.string().datetime(),
  runId: z.number().int().nonnegative(), runAttempt: z.number().int().positive(),
  jobId: z.string().min(1).max(128), stepId: z.string().max(128),
  line: z.string().max(65536),
});
export type LogLine = z.infer<typeof logLineSchema>;
export interface FailureContext { lines: LogLine[]; notes: string[] }
export interface AuditEvent { id: string; actor: string; action: string; target: string; createdAt: string; detail: string }
export interface Viewer { id: number; login: string; avatarUrl: string }
export interface Overview {
  viewer: Viewer; hosts: Host[]; jobs: Job[]; repositories: Repository[];
  connections: Connection[]; audit: AuditEvent[];
}
export const heartbeatSchema = z.object({
  version: z.string().max(64), metrics: hostMetricsSchema,
  currentJobId: z.string().max(128).nullable(), labels: z.array(z.string().max(128)).max(30),
  admissionReason: z.string().max(160).nullable().optional(),
});
export interface Lease {
  id: string; jobId: string; repository: string; runId: number; runAttempt: number;
  headSha: string; runnerName: string; encodedJitConfig: string; expiresAt: string;
}
export interface AgentConfiguration {
  relayUrl: string; hostId: string; token: string; name: string;
  platform: "darwin" | "linux"; architecture: "arm64" | "x64";
  labels: string[]; runnerDirectory: string; stateDirectory: string;
  maxSpoolBytes: number; sharedMaxCpuPercent: number; sharedMinFreeMemoryBytes: number;
}
export type FleetEvent =
  | { type: "refresh" }
  | { type: "logs"; jobId: string; lines: LogLine[] }
  | { type: "host_mode"; hostId: string; mode: HostMode }
  | { type: "error"; message: string };
export const PROTOCOL_VERSION = 1;
