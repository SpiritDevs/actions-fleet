import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { LogLine } from "@actions-fleet/protocol";
import { failureContext } from "../src/failure-context.ts";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function history() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE logs (job_id TEXT NOT NULL, cursor INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX job_logs ON logs(job_id,cursor);
    CREATE TABLE log_cursors (job_id TEXT PRIMARY KEY,last_cursor INTEGER NOT NULL);
  `);
  const insert = database.prepare("INSERT INTO logs VALUES (?,?,?)");
  const seed = (jobId: string, entries: [number, string][], last = entries.at(-1)?.[0] ?? 0) => {
    database.exec("BEGIN");
    for (const [sequence, text] of entries) {
      const line: LogLine = { sequence, timestamp: "2026-09-20T00:00:00.000Z", runId: 21, runAttempt: 1, jobId, stepId: "step", line: text };
      insert.run(jobId, sequence, JSON.stringify(line));
    }
    database.prepare("INSERT OR REPLACE INTO log_cursors VALUES (?,?)").run(jobId, last);
    database.exec("COMMIT");
  };
  const results: { query: string; rows: number; bytes: number }[] = [];
  const query = <T>(sql: string, ...values: (string | number)[]): T[] => {
    const rows = database.prepare(sql).all(...values);
    results.push({ query: sql, rows: rows.length, bytes: Buffer.byteLength(JSON.stringify(rows)) });
    return rows as T[];
  };
  return { seed, query, results };
}

describe("bounded retained failure context", () => {
  it("keeps an early failure and its cause after more than 3000 cleanup records, scoped to one job", () => {
    const { seed, query, results } = history();
    const entries: [number, string][] = Array.from({ length: 3300 }, (_, index) => [index + 1, `cleanup ${index + 1}`]);
    entries[2] = [3, "Database returned an unexpected row count"];
    entries[3] = [4, "AssertionError: expected 2 rows, received 0"];
    entries[4] = [5, "Expected: 2; Received: 0"];
    entries[1200] = [1201, "✓ handles errors while closing a connection"];
    entries[3298] = [3299, "##[error]Process completed with exit code 1."];
    seed("target", entries);
    seed("other", [[1, "fatal: output from a different private job"]]);

    const excerpt = failureContext(query, "target");
    expect(excerpt.lines.map(line => line.sequence)).toEqual(expect.arrayContaining([3, 4, 5, 3299, 3300]));
    expect(excerpt.lines.every(line => line.jobId === "target")).toBe(true);
    expect(excerpt.lines.some(line => line.line.includes("different private job"))).toBe(false);
    expect(excerpt.lines.some(line => line.sequence === 1201)).toBe(false);
    const cursors = excerpt.lines.map(line => line.sequence);
    expect(cursors).toEqual([...new Set(cursors)].sort((a, b) => a - b));
    expect(excerpt.notes.join(" ")).toContain("of 3300 retained console records");
    expect(excerpt.notes.join(" ")).toContain("not a complete log");
    // Scans happen in SQLite, never as a whole-history JS result. Text-bearing
    // reads use the small window query even with thousands of retained rows.
    expect(results.every(result => result.rows <= 80)).toBe(true);
    expect(results.filter(result => result.query.includes("AS excerpt")).every(result => result.rows <= 16)).toBe(true);
  });

  it("keeps first and last error anchors under Unicode and serialized-payload bounds", () => {
    const { seed, query, results } = history();
    const entries: [number, string][] = Array.from({ length: 1000 }, (_, index) => [index + 1, `cleanup ${index + 1}`]);
    const anchors = Array.from({ length: 32 }, (_, index) => 5 + index * 20);
    for (const [index, sequence] of anchors.entries()) {
      entries[sequence - 1] = [sequence, `${"😀".repeat(12000)}error: important failure ${index}${'\n"\\'.repeat(500)}`];
    }
    seed("unicode", entries);
    const excerpt = failureContext(query, "unicode");
    expect(excerpt.lines.some(line => line.sequence === anchors[0] && line.line.includes("error: important failure 0"))).toBe(true);
    expect(excerpt.lines.some(line => line.sequence === anchors.at(-1) && line.line.includes("error: important failure 31"))).toBe(true);
    expect(excerpt.lines.some(line => line.sequence === 1000)).toBe(true);
    expect(excerpt.lines.length).toBeLessThanOrEqual(400);
    expect(Buffer.byteLength(JSON.stringify(excerpt))).toBeLessThanOrEqual(64 * 1024);
    expect(excerpt.lines.every(line => Buffer.byteLength(JSON.stringify(line)) <= 1536)).toBe(true);
    expect(excerpt.lines.every(line => !line.line.includes("�") && Buffer.from(line.line).toString("utf8") === line.line)).toBe(true);
    expect(excerpt.notes.join(" ")).toContain("selected log records were shortened");
    expect(excerpt.notes.join(" ")).toContain("Some candidate records were omitted");
    expect(results.every(result => result.bytes < 128 * 1024)).toBe(true);
  });

  it("reports actual retention gaps separately from selection omissions", () => {
    const { seed, query } = history();
    seed("gaps", [[4, "error: retained failure"], [5, "failure detail"], [9, "cleanup"]], 12);
    const excerpt = failureContext(query, "gaps");
    expect(excerpt.lines.map(line => line.sequence)).toEqual([4, 5, 9]);
    expect(excerpt.notes).toContain("9 previously received log records are no longer retained (retention or storage limits); earlier failures may be unavailable.");
    expect(excerpt.notes.join(" ")).toContain("Selected 3 of 3 retained console records");
  });

  it("explains empty retention without implying the job emitted no output", () => {
    const { seed, query } = history();
    seed("evicted", [], 42);
    const evicted = failureContext(query, "evicted");
    expect(evicted.lines).toEqual([]);
    expect(evicted.notes.join(" ")).toContain("42 previously received log records are no longer retained");
    const unseen = failureContext(query, "unseen");
    expect(unseen.lines).toEqual([]);
    expect(unseen.notes).toEqual(["No retained console records are available for this job. This does not establish whether the job emitted output."]);
  });

  it("uses only the tail when passing test descriptions contain generic error words", () => {
    const { seed, query } = history();
    seed("passed", Array.from({ length: 300 }, (_, index) => [index + 1, `✓ handles errors in operation ${index}`]));
    const excerpt = failureContext(query, "passed");
    expect(excerpt.lines).toHaveLength(80);
    expect(excerpt.lines[0]!.sequence).toBe(221);
    expect(excerpt.lines.at(-1)!.sequence).toBe(300);
    expect(excerpt.notes).toContain("No strong error markers matched the retained records; the excerpt contains recent output only.");
  });

  it.each([
    "##[error]a failed step",
    "::error file=src/main.ts,line=4::type mismatch",
    "fatal: unable to find remote ref",
    "src/index.ts(4,2): error TS2322: types do not match",
    " FAIL  src/main.test.ts > reports invalid input",
    "FAILED tests/test_main.py::test_input - AssertionError",
  ])("recognizes concrete diagnostic syntax: %s", diagnostic => {
    const { seed, query } = history();
    seed("formats", [[1, diagnostic], ...Array.from({ length: 100 }, (_, index): [number, string] => [index + 2, "cleanup"])]);
    expect(failureContext(query, "formats").lines[0]!.line).toBe(diagnostic);
  });
});
