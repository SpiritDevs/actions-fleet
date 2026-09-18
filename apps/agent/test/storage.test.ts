import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat, chmod, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuration, lease, raw } from "./fixtures.js";
import { loadConfiguration, saveConfiguration } from "../src/config.js";
import { readJson, writeJson } from "../src/files.js";
import { LogSpool, restoreSpools, spoolDiskBytes } from "../src/spool.js";

const directories: string[] = [];
async function directory(): Promise<string> {const value = await mkdtemp(join(tmpdir(),"fleet-storage-test-"));directories.push(value);return value;}
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});

describe("private configuration",()=>{
  it("persists a private configuration and rejects a world-readable token file",async()=>{
    const path = await directory(), config = configuration(path);
    await saveConfiguration(config);
    expect((await stat(join(path,"config.json"))).mode & 0o777).toBe(0o600);
    expect(await loadConfiguration(path)).toEqual(config);
    await chmod(join(path,"config.json"),0o644);
    await expect(loadConfiguration(path)).rejects.toThrow(/private/);
  });
});

describe("durable masked log replay",()=>{
  it("waits for complete UTF-8 records, recovers cursor after interrupted state write, and never reuses acknowledged sequences",async()=>{
    const root = await directory(), spool = await LogSpool.create(root,lease(),join(root,"job"),2e6);
    const before = await readFile(join(spool.directory,"state.json"));
    const record = Buffer.from(raw("unicode 🍀 ***"));
    await writeFile(spool.sourcePath,record.subarray(0,record.length-3));
    await spool.ingest(); expect(spool.batch()).toHaveLength(0);
    await appendFile(spool.sourcePath,record.subarray(record.length-3));
    await spool.ingest(); expect(spool.batch()[0].line).toBe("unicode 🍀 ***");
    await writeFile(join(spool.directory,"state.json"),before); // Crash after event fsync, before cursor commit.
    await appendFile(join(spool.directory,"events.ndjson"),'{"partial":');
    const restored = await LogSpool.restore(spool.directory);
    await restored.ingest(); expect(restored.batch().map(line=>line.sequence)).toEqual([1]);
    await restored.acknowledge(1,1);
    const reopened = await LogSpool.restore(spool.directory);
    await appendFile(reopened.sourcePath,raw("second"));await reopened.ingest();
    expect(reopened.batch().map(line=>line.sequence)).toEqual([2]);
    await expect(reopened.acknowledge(3,2)).rejects.toThrow(/outside/);
    expect(await readFile(join(spool.directory,"manifest.json"),"utf8")).not.toContain(lease().encodedJitConfig);
  });
  it("records a bounded explicit gap using the stable runner GUID when replay storage fills",async()=>{
    const root = await directory(), original = await LogSpool.create(root,lease(),join(root,"job"),2e6);
    const manifest = await readJson<Record<string,unknown>>(join(original.directory,"manifest.json"));
    await writeJson(join(original.directory,"manifest.json"),{...manifest,eventLimit:80_000});
    const spool = await LogSpool.restore(original.directory);
    await writeFile(spool.sourcePath,raw("x".repeat(60_000))+raw("y".repeat(60_000))+raw("z".repeat(60_000)));
    await spool.ingest(true);
    const batch = spool.batch();
    expect(batch[0].sequence).toBe(1);expect(batch.some(line=>line.line.includes("fleet log gap"))).toBe(true);
    expect(new Set(batch.map(line=>line.jobId))).toEqual(new Set(["05171998-88ea-5521-b4a5-3e2d89039030"]));
    expect(spool.degraded).toMatch(/limit/);
    expect((await stat(join(spool.directory,"events.ndjson"))).size).toBeLessThanOrEqual(80_000);
    const reopened = await LogSpool.restore(spool.directory);
    expect(reopened.batch()).toEqual(batch);
  });
  it("keeps rejected data on disk within the budget and excludes it from automatic retry",async()=>{
    const root = await directory(), spool = await LogSpool.create(root,lease(),join(root,"job"),2e6);
    await writeFile(spool.sourcePath,raw());await spool.ingest();
    await spool.quarantine("Server could not verify runner assignment");
    expect(await restoreSpools(root)).toHaveLength(0);
    expect(await spoolDiskBytes(root)).toBeGreaterThan(0);
    expect(await readFile(spool.sourcePath,"utf8")).toContain("masked");
  });
  it("rejects duplicate lease execution and turns a truncated final record into a visible gap",async()=>{
    const root = await directory(), spool = await LogSpool.create(root,lease(),join(root,"job"),2e6);
    await expect(LogSpool.create(root,lease(),join(root,"job"),2e6)).rejects.toThrow();
    await writeFile(spool.sourcePath,raw()+"{partial");await spool.ingest(true);
    expect(spool.batch().at(-1)?.line).toMatch(/incomplete/);
  });
  it("reports missing capture after an admitted job instead of silently succeeding with empty logs",async()=>{
    const root = await directory(), spool = await LogSpool.create(root,lease(),join(root,"job"),2e6);
    await spool.bindAdmission(lease());
    await spool.ingest(true);
    expect(spool.degraded).toMatch(/No masked runner capture/);
    expect(spool.hasUnidentifiedGap).toBe(true);
  });
});
