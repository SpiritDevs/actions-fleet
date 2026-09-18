import { describe, expect, it } from "vitest";
import type { Job, LogLine } from "@actions-fleet/protocol";
import { durationSeconds, formatDuration, hostAdmissionMessage, matchesJob, mergeLogLines, percentile, stripAnsi } from "./model";

const line = (sequence: number, text = `line ${sequence}`): LogLine => ({ sequence, line: text, timestamp: "2026-09-19T00:00:00.000Z", runId: 1, runAttempt: 1, jobId: "1", stepId: "build" });
const job: Job = { id: "1", runId: 1, runAttempt: 1, repository: "SpiritDevs/pathway", installationId: 1, workflowName: "Release", name: "Build macOS", branch: "main", headSha: "abc123def", actor: "corey", status: "completed", conclusion: "success", labels: [], hostId: null, runnerName: null, createdAt: "2026-09-19T00:00:00.000Z", startedAt: "2026-09-19T00:01:00.000Z", completedAt: "2026-09-19T00:03:30.000Z", htmlUrl: "https://github.com/SpiritDevs/pathway/actions/runs/1", steps: [] };

describe("host admission visibility", () => {
  it("shows local pauses and shared resource waits while keeping older reports compatible", () => {
    const host = {mode:"shared" as const,status:"online" as const};
    expect(hostAdmissionMessage(host)).toBe("Ready for compatible jobs");
    expect(hostAdmissionMessage({...host,admissionReason:null})).toBe("Ready for compatible jobs");
    for (const admissionReason of ["Paused on this machine","Shared mode is waiting for lower CPU usage","Shared mode is waiting for available memory"]) {
      expect(hostAdmissionMessage({...host,admissionReason})).toBe(admissionReason);
    }
  });
  it("gives remotely paused and offline states precedence over old admission telemetry", () => {
    const host = {mode:"shared" as const,status:"online" as const,admissionReason:"Paused on this machine"};
    expect(hostAdmissionMessage({...host,status:"offline"})).toBe("Waiting to reconnect");
    expect(hostAdmissionMessage({...host,mode:"paused"})).toBe("Admission paused");
    expect(hostAdmissionMessage({...host,mode:"paused",status:"offline"})).toBe("Admission paused");
  });
});

describe("console replay", () => {
  it("merges HTTP replay with live output in sequence order without duplicates", () => {
    expect(mergeLogLines([line(7), line(9)], [line(8), line(7), line(10)]).map((item) => item.sequence)).toEqual([7, 8, 9, 10]);
  });
  it("keeps the newest bounded window when old replay arrives after live output", () => {
    expect(mergeLogLines([line(9), line(10)], [line(1), line(2), line(8)], 3).map((item) => item.sequence)).toEqual([8, 9, 10]);
  });
  it("removes ANSI colors and terminal hyperlinks without rendering markup", () => {
    expect(stripAnsi("\u001b[31mfailed\u001b[0m <script>text</script>")).toBe("failed <script>text</script>");
    expect(stripAnsi("\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007")).toBe("link");
  });
});

describe("job filters and summaries", () => {
  it("combines repository, case-insensitive search, status, and time without treating skips as success", () => {
    expect(matchesJob(job, "ABC123", "SpiritDevs/pathway", "success", 0)).toBe(true);
    expect(matchesJob({ ...job, conclusion: "skipped" }, "", "", "success", 0)).toBe(false);
    expect(matchesJob({ ...job, conclusion: "timed_out" }, "", "", "failed", 0)).toBe(true);
    expect(matchesJob(job, "", "another/repo", "all", 0)).toBe(false);
    expect(matchesJob(job, "", "", "all", new Date("2026-09-20").getTime())).toBe(false);
  });
  it("reports run durations only after execution starts", () => {
    expect(durationSeconds(job)).toBe(150);
    expect(durationSeconds({ ...job, startedAt: null, completedAt: null })).toBeNull();
    expect(formatDuration(150)).toBe("2m 30s");
    expect(formatDuration(null)).toBe("—");
  });
  it("does not invent aggregate durations for empty data", () => {
    expect(percentile([], .95)).toBeNull();
    expect(percentile([10, 40, 20, 30], .5)).toBe(20);
  });
});
