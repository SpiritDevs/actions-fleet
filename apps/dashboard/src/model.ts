import type { Job, LogLine } from "@actions-fleet/protocol";

export const LOG_WINDOW = 3000;
export type JobFilter = "all" | "active" | "queued" | "waiting_approval" | "success" | "failed" | "cancelled";

export function jobResult(job: Job): string {
  return job.status === "completed" ? job.conclusion || "completed" : job.status;
}

export function matchesJob(job: Job, search: string, repository: string, status: JobFilter, since: number): boolean {
  if (repository && job.repository !== repository) return false;
  if (since && new Date(job.createdAt).getTime() < since) return false;
  const value = jobResult(job);
  if (status === "active" && job.status !== "in_progress") return false;
  if (status === "failed" && !["failure", "timed_out", "action_required", "startup_failure"].includes(value)) return false;
  if (!["all", "active", "failed"].includes(status) && value !== status) return false;
  const haystack = `${job.repository} ${job.workflowName} ${job.name} ${job.branch} ${job.headSha} ${job.actor} ${job.runnerName || ""}`.toLowerCase();
  return haystack.includes(search.trim().toLowerCase());
}

export function durationSeconds(job: Job, now = Date.now()): number | null {
  if (!job.startedAt) return null;
  return Math.max(0, ((job.completedAt ? new Date(job.completedAt).getTime() : now) - new Date(job.startedAt).getTime()) / 1000);
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function mergeLogLines(existing: LogLine[], incoming: LogLine[], limit = LOG_WINDOW): LogLine[] {
  const bySequence = new Map(existing.map((line) => [line.sequence, line]));
  for (const line of incoming) bySequence.set(line.sequence, line);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence).slice(-limit);
}

export function stripAnsi(value: string): string {
  // Render console text as text, never as HTML or terminal escape instructions.
  return value.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}
