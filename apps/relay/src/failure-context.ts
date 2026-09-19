import type { FailureContext, LogLine } from "@actions-fleet/protocol";

type Query = <T>(sql: string, ...values: (string | number)[]) => T[];
interface CursorRow { cursor: number }
interface ExcerptRow extends CursorRow { metadata: string; excerpt: string; start: number; length: number }

const MAX_LINES = 400;
const MAX_RESPONSE_BYTES = 64 * 1024;
// Leave room for JSON punctuation and all fixed-size explanatory notes.
const LINE_BUDGET = MAX_RESPONSE_BYTES - 2048;
const MAX_RECORD_BYTES = 1536;
const SQL_EXCERPT_CHARACTERS = 1536;
const ANCHORS_PER_END = 12;
const NEIGHBORS = 6;
const TAIL_LINES = 80;
const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).byteLength;

// Match concrete diagnostic formats, not generic test names such as "handles
// errors". SQL examines only this job's retained rows, returning cursor IDs.
// Zero means no match; the sentinel lets min() choose the first actual marker.
const markerExpressions = [
  "instr(text, '##[error]')",
  "CASE WHEN text LIKE '%::error::%' OR text LIKE '%::error %' THEN instr(text, '::error') ELSE 0 END",
  "instr(lower(text), 'error:')",
  "instr(lower(text), 'fatal:')",
  "CASE WHEN lower(text) GLOB '*error ts[0-9][0-9][0-9][0-9]:*' THEN instr(lower(text), 'error ts') ELSE 0 END",
  "CASE WHEN ltrim(text) GLOB 'FAIL  *' OR ltrim(text) GLOB 'FAILED *' THEN instr(text, 'FAIL') ELSE 0 END",
];
const NO_MARKER = 2147483647;
const markerPosition = `min(${markerExpressions.map(expression => `coalesce(nullif(${expression}, 0), ${NO_MARKER})`).join(",")})`;

function decodeExcerpt(row: ExcerptRow): { line: LogLine; clipped: boolean } {
  const suffix = " [… log record truncated …]";
  const prefix = row.start > 1 ? "[… start of log record omitted …] " : "";
  const clippedInSql = row.start > 1 || row.length >= row.start + SQL_EXCERPT_CHARACTERS;
  const line = JSON.parse(row.metadata) as LogLine;
  line.line = prefix + row.excerpt + (row.length >= row.start + SQL_EXCERPT_CHARACTERS ? suffix : "");
  if (byteLength(JSON.stringify(line)) <= MAX_RECORD_BYTES) return { line, clipped: clippedInSql };

  // Bound the serialized UTF-8 record, including escaping and metadata. Work
  // with code points so truncation never splits a Unicode surrogate pair.
  const characters = Array.from(prefix + row.excerpt);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    line.line = characters.slice(0, middle).join("") + suffix;
    if (byteLength(JSON.stringify(line)) <= MAX_RECORD_BYTES) low = middle;
    else high = middle - 1;
  }
  line.line = characters.slice(0, low).join("") + suffix;
  return { line, clipped: true };
}

/** A bounded excerpt of retained, already-masked console records; no upstream fetch. */
export function failureContext(query: Query, jobId: string): FailureContext {
  const stats = query<{ retained: number; last: number }>(
    "SELECT COUNT(*) AS retained,COALESCE(MAX(cursor),0) AS last FROM logs WHERE job_id=?", jobId,
  )[0]!;
  const received = query<{ last_cursor: number }>("SELECT last_cursor FROM log_cursors WHERE job_id=?", jobId)[0]?.last_cursor ?? stats.last;
  const missing = Math.max(0, received - stats.retained);
  const notes: string[] = [];
  if (missing) notes.push(`${missing} previously received log records are no longer retained (retention or storage limits); earlier failures may be unavailable.`);
  if (!stats.retained) {
    notes.push("No retained console records are available for this job. This does not establish whether the job emitted output.");
    return { lines: [], notes };
  }

  const findAnchors = (direction: "ASC" | "DESC") => query<CursorRow>(`
    WITH job_lines AS (
      SELECT cursor,json_extract(data,'$.line') AS text FROM logs INDEXED BY job_logs WHERE job_id=?
    )
    SELECT cursor FROM job_lines WHERE ${markerPosition} < ${NO_MARKER}
    ORDER BY cursor ${direction} LIMIT ${ANCHORS_PER_END}`, jobId).map(row => row.cursor);
  const first = findAnchors("ASC");
  const last = findAnchors("DESC");
  // Alternate earliest/latest anchors so both ends survive any later bounds.
  const anchors = [...new Set(first.flatMap((cursor, index) => [cursor, last[index]!]))];
  const neighbors = new Map<number, number>();
  for (const anchor of anchors) {
    const rows = query<CursorRow>("SELECT cursor FROM logs WHERE job_id=? AND cursor BETWEEN ? AND ? ORDER BY cursor", jobId, anchor - NEIGHBORS, anchor + NEIGHBORS);
    for (const row of rows) neighbors.set(row.cursor, Math.min(neighbors.get(row.cursor) ?? Infinity, Math.abs(row.cursor - anchor)));
  }
  const nearby = [...neighbors].sort(([a, distanceA], [b, distanceB]) => distanceA - distanceB || a - b).map(([cursor]) => cursor);
  const tail = query<CursorRow>(`SELECT cursor FROM logs WHERE job_id=? ORDER BY cursor DESC LIMIT ${TAIL_LINES}`, jobId).map(row => row.cursor);
  const selected = new Map<number, LogLine>();
  let bytes = 0;
  let clippedRecords = 0;

  const add = (cursors: number[], phaseBudget: number) => {
    let phaseBytes = 0;
    const pending = cursors.filter(cursor => !selected.has(cursor));
    // No full record or whole job history crosses into JS. SQLite slices each
    // text around its first diagnostic (or its start); at most 16 small rows
    // are materialized per query, even for huge Unicode/payload records.
    for (let offset = 0; offset < pending.length; offset += 16) {
      const batch = pending.slice(offset, offset + 16);
      const rows = query<ExcerptRow>(`
        WITH records AS (
          SELECT cursor,data,json_extract(data,'$.line') AS text
          FROM logs WHERE job_id=? AND cursor IN (${batch.map(() => "?").join(",")})
        ), positions AS (
          SELECT *,${markerPosition} AS marker FROM records
        ), windows AS (
          SELECT *,CASE WHEN marker < ${NO_MARKER} THEN max(1,marker-120) ELSE 1 END AS start FROM positions
        )
        SELECT cursor,json_remove(data,'$.line') AS metadata,length(text) AS length,start,
          substr(text,start,${SQL_EXCERPT_CHARACTERS}) AS excerpt FROM windows`, jobId, ...batch);
      const byCursor = new Map(rows.map(row => [row.cursor, row]));
      for (const cursor of batch) {
        const row = byCursor.get(cursor);
        if (!row) continue;
        const record = decodeExcerpt(row);
        const size = byteLength(JSON.stringify(record.line)) + 1;
        if (selected.size >= MAX_LINES || bytes + size > LINE_BUDGET || phaseBytes + size > phaseBudget) continue;
        selected.set(cursor, record.line);
        bytes += size; phaseBytes += size;
        if (record.clipped) clippedRecords++;
      }
    }
  };
  add(anchors, LINE_BUDGET);
  // Reserve at most a quarter of the response for recent output, preventing a
  // long cleanup tail from displacing the earlier diagnostic and its context.
  add(tail, anchors.length ? 16 * 1024 : LINE_BUDGET);
  add(nearby, LINE_BUDGET);
  const lines = [...selected].sort(([a], [b]) => a - b).map(([, line]) => line);
  notes.push(`Selected ${lines.length} of ${stats.retained} retained console records: up to 12 earliest and 12 latest strong error markers, up to 6 neighboring records on either side, and up to 80 recent tail records. This is a bounded excerpt, not a complete log.`);
  if (!anchors.length) notes.push("No strong error markers matched the retained records; the excerpt contains recent output only.");
  const candidateCount = new Set([...anchors, ...nearby, ...tail]).size;
  if (candidateCount > selected.size) notes.push("Some candidate records were omitted to keep the excerpt within 400 records and 64 KiB of UTF-8 JSON, including a bounded share for the tail.");
  if (clippedRecords) notes.push(`${clippedRecords} selected log records were shortened; inline omission markers identify clipped text. Each serialized record is limited to ${MAX_RECORD_BYTES} bytes.`);
  return { lines, notes };
}
