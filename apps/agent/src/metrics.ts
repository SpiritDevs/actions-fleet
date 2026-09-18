import { cpus, freemem, totalmem, loadavg } from "node:os";
import { readFile, statfs } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HostMetrics } from "@actions-fleet/protocol";

const runFile = promisify(execFile);
const SAMPLE_TIMEOUT_MS = 1000;

function boundedMemory(value: number, total: number): number | null {
  return Number.isSafeInteger(value) && value >= 0 && value <= total ? value : null;
}

function singleNumber(output: string, pattern: RegExp): number | null {
  const matches = [...output.matchAll(pattern)];
  if (matches.length !== 1) return null;
  const value = Number(matches[0][1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseDarwinAvailableMemory(output: string, total: number): number | null {
  const pageSize = singleNumber(output,/^Mach Virtual Memory Statistics: \(page size of (\d+) bytes\)\r?$/gm);
  if (pageSize === null || pageSize === 0 || !Number.isInteger(Math.log2(pageSize))) return null;
  const counts = ["free","inactive","speculative"].map(name=>singleNumber(output,new RegExp(`^Pages ${name}:[ \\t]*(\\d+)\\.?[ \\t]*\\r?$`,"gm")));
  if (counts.some(count=>count === null)) return null;
  // Apple's vm_stat subtracts speculative_count from the displayed free count.
  // These displayed queues are disjoint; purgeable/file-backed totals overlap
  // them and must not be added. See system_cmds/vm_stat/vm_stat.c, snapshot().
  return boundedMemory(counts.reduce<number>((sum,count)=>sum+count!,0)*pageSize,total);
}

export function parseLinuxAvailableMemory(output: string, total: number): number | null {
  const kibibytes = singleNumber(output,/^MemAvailable:[ \t]*(\d+)[ \t]+kB[ \t]*\r?$/gm);
  return kibibytes === null ? null : boundedMemory(kibibytes*1024,total);
}

async function readMemoryStatistics(platform: NodeJS.Platform): Promise<string> {
  if (platform === "darwin") {
    const result = await runFile("/usr/bin/vm_stat",[],{encoding:"utf8",timeout:SAMPLE_TIMEOUT_MS,maxBuffer:16*1024,env:{LC_ALL:"C",LANG:"C"}});
    return result.stdout;
  }
  if (platform === "linux") return readFile("/proc/meminfo",{encoding:"utf8",signal:AbortSignal.timeout(SAMPLE_TIMEOUT_MS)});
  throw new Error("Available memory statistics are unsupported on this platform");
}

export async function availableMemoryBytes(platform: NodeJS.Platform, total: number, free: number, readStatistics = () => readMemoryStatistics(platform)): Promise<number> {
  const fallback = boundedMemory(free,total) ?? 0;
  if (platform !== "darwin" && platform !== "linux") return fallback;
  try {
    const output = await readStatistics();
    return (platform === "darwin" ? parseDarwinAvailableMemory(output,total) : parseLinuxAvailableMemory(output,total)) ?? fallback;
  } catch {return fallback;}
}

function cpuSample(): {idle: number; total: number; count: number} {
  const values = cpus();
  return values.reduce((sum, cpu) => ({idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a,b) => a+b,0), count: sum.count+1}), {idle:0,total:0,count:0});
}

export class MetricsCollector {
  private previous = cpuSample();
  async sample(directory: string): Promise<HostMetrics> {
    const current = cpuSample(), elapsed = current.total - this.previous.total, idle = current.idle - this.previous.idle;
    const total = totalmem(), free = freemem();
    const [disk,memoryAvailableBytes] = await Promise.all([statfs(directory),availableMemoryBytes(process.platform,total,free)]);
    const cpuPercent = elapsed > 0 ? Math.max(0, Math.min(100, 100 * (1 - idle / elapsed))) : 0;
    this.previous = current;
    return {cpuPercent, memoryUsedBytes: total - free, memoryTotalBytes: total, memoryAvailableBytes, diskFreeBytes: Number(disk.bavail) * Number(disk.bsize), loadAverage: Math.max(0, loadavg()[0]), cpuCount: Math.max(1,current.count)};
  }
}
