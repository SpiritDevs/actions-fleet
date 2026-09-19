import { expect, it, vi } from "vitest";
import type { FailureContext, Job, LogLine } from "@actions-fleet/protocol";
import { copyFixPrompt } from "./fixPromptClipboard";

const job: Job = { id: "31", runId: 21, runAttempt: 2, repository: "owner/repo", installationId: 7, workflowName: "CI", name: "Build", branch: "main", headSha: "a".repeat(40), actor: "owner", status: "completed", conclusion: "failure", labels: [], hostId: null, runnerName: null, createdAt: "2026-09-19T00:00:00Z", startedAt: null, completedAt: null, htmlUrl: "https://github.com/owner/repo/actions/runs/21/job/31", steps: [] };
const line = (sequence: number, text: string): LogLine => ({ sequence, line: text, timestamp: job.createdAt, runId: job.runId, runAttempt: job.runAttempt, jobId: job.id, stepId: "compile" });
const input = { job, lines: [line(4000, "loaded UI tail")], contextNotes: [], dashboardUrl: "https://fleet.example/?view=runs&job=31" };
const context: FailureContext = { lines: [line(4, "error: causal failure outside the visible window")], notes: ["Selected error windows from retained history."] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

it("copies retained failure context beyond the console window", async () => {
  const writeClipboard = vi.fn(async () => {});
  const result = await copyFixPrompt(input, { loadContext: async () => context, writeClipboard, isCurrent: () => true });
  expect(result?.copied).toBe(true);
  expect(result?.usedLoadedLogs).toBe(false);
  expect(result?.text).toContain("causal failure outside the visible window");
  expect(result?.text).not.toContain("loaded UI tail");
  expect(writeClipboard).toHaveBeenCalledExactlyOnceWith(result?.text);
});

it("returns selectable prompt text when clipboard permission is denied", async () => {
  const result = await copyFixPrompt(input, { loadContext: async () => context, writeClipboard: async () => { throw new Error("Denied"); }, isCurrent: () => true });
  expect(result?.copied).toBe(false);
  expect(result?.text).toContain("causal failure outside the visible window");
});

it("clearly labels a loaded-window fallback when history fetching fails", async () => {
  const result = await copyFixPrompt(input, { loadContext: async () => { throw new Error("Unavailable"); }, writeClipboard: async () => {}, isCurrent: () => true });
  expect(result?.usedLoadedLogs).toBe(true);
  expect(result?.text).toContain("loaded UI tail");
  expect(result?.text).toContain("older errors may be missing");
  expect(result?.text).not.toContain("Unavailable");
});

it("does not copy stale context when the selected job changes during retrieval", async () => {
  const loading = deferred<FailureContext>();
  const writeClipboard = vi.fn(async () => {});
  let current = true;
  const pending = copyFixPrompt(input, { loadContext: () => loading.promise, writeClipboard, isCurrent: () => current });
  current = false; loading.resolve(context);
  expect(await pending).toBeNull();
  expect(writeClipboard).not.toHaveBeenCalled();
});

it("ignores a clipboard completion after its job closes", async () => {
  const writing = deferred<void>();
  const started = deferred<void>();
  let current = true;
  const pending = copyFixPrompt(input, { loadContext: async () => context, writeClipboard: () => { started.resolve(); return writing.promise; }, isCurrent: () => current });
  await started.promise; current = false; writing.resolve();
  expect(await pending).toBeNull();
});
