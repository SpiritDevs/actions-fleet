import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { availableMemoryBytes, MetricsCollector, parseDarwinAvailableMemory, parseLinuxAvailableMemory } from "../src/metrics.js";

const GiB = 1024 ** 3;
const darwin = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               14625.
Pages active:                            884095.
Pages inactive:                          822754.
Pages speculative:                        61271.
Pages wired down:                        205237.
Pages purgeable:                          23767.
File-backed pages:                       734112.
Pages stored in compressor:              129411.
`;

describe("available memory for native admission",()=>{
  it("counts Darwin's displayed disjoint queues with the reported page size",()=>{
    // Snapshot from the second Mac: inactive cache can be reclaimed even when
    // Node's free-memory metric is below the 4 GiB Shared admission threshold.
    const pages = 14625 + 822754 + 61271;
    expect(parseDarwinAvailableMemory(darwin,32*GiB)).toBe(pages*16384);
    expect(parseDarwinAvailableMemory(darwin.replace("16384 bytes","4096 bytes"),32*GiB)).toBe(pages*4096);
    expect(parseDarwinAvailableMemory(darwin.replace("23767.","99999999."),32*GiB)).toBe(pages*16384);
  });
  it("rejects incomplete, ambiguous and impossible Darwin snapshots",()=>{
    for (const text of ["",darwin.replace(/Pages inactive:.*\n/,""),darwin+"Pages free: 1.\n",darwin.replace("14625.","-1."),darwin.replace("16384 bytes","0 bytes"),darwin.replace("16384 bytes","3 bytes"),darwin.replace("822754.","9007199254740993.")]) {
      expect(parseDarwinAvailableMemory(text,32*GiB)).toBeNull();
    }
    expect(parseDarwinAvailableMemory(darwin,4*GiB)).toBeNull();
  });
  it("reads Linux MemAvailable without adding caches or interpreting kB as decimal bytes",()=>{
    const text = "MemTotal: 33554432 kB\nMemFree: 1024 kB\nMemAvailable: 8388608 kB\nCached: 4194304 kB\n";
    expect(parseLinuxAvailableMemory(text,32*GiB)).toBe(8*GiB);
    expect(parseLinuxAvailableMemory("MemAvailable: 0 kB\n",32*GiB)).toBe(0);
    for (const invalid of ["MemFree: 8000000 kB\n","MemAvailable: -1 kB\n","MemAvailable: 8 MB\n","MemAvailable: 1 kB\nMemAvailable: 2 kB\n","MemAvailable: 9007199254740993 kB\n"]) {
      expect(parseLinuxAvailableMemory(invalid,32*GiB)).toBeNull();
    }
    expect(parseLinuxAvailableMemory(text,4*GiB)).toBeNull();
  });
  it("uses a conservative bounded free-memory fallback on missing data, errors and timeouts",async()=>{
    expect(await availableMemoryBytes("darwin",32*GiB,GiB,async()=>darwin)).toBeGreaterThan(4*GiB);
    expect(await availableMemoryBytes("linux",32*GiB,GiB,async()=>"MemAvailable: 0 kB\n")).toBe(0);
    for (const platform of ["darwin","linux"] as const) {
      expect(await availableMemoryBytes(platform,32*GiB,GiB,async()=>"malformed")).toBe(GiB);
      expect(await availableMemoryBytes(platform,32*GiB,GiB,async()=>{throw new Error("unavailable");})).toBe(GiB);
      expect(await availableMemoryBytes(platform,32*GiB,GiB,async()=>{throw new DOMException("expired","TimeoutError");})).toBe(GiB);
      expect(await availableMemoryBytes(platform,32*GiB,-1,async()=>"malformed")).toBe(0);
      expect(await availableMemoryBytes(platform,32*GiB,64*GiB,async()=>"malformed")).toBe(0);
    }
  });
  it("collects bounded real native metrics without changing used-memory meaning",async()=>{
    const metrics = await new MetricsCollector().sample(tmpdir());
    expect(metrics.memoryAvailableBytes).toBeGreaterThanOrEqual(0);
    expect(metrics.memoryAvailableBytes).toBeLessThanOrEqual(metrics.memoryTotalBytes);
    expect(metrics.memoryUsedBytes).toBeGreaterThanOrEqual(0);
    expect(metrics.memoryUsedBytes).toBeLessThanOrEqual(metrics.memoryTotalBytes);
  });
});
