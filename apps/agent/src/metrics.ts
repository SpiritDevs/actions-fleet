import { cpus, freemem, totalmem, loadavg } from "node:os";
import { statfs } from "node:fs/promises";
import type { HostMetrics } from "@actions-fleet/protocol";

function cpuSample(): {idle: number; total: number; count: number} {
  const values = cpus();
  return values.reduce((sum, cpu) => ({idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a,b) => a+b,0), count: sum.count+1}), {idle:0,total:0,count:0});
}

export class MetricsCollector {
  private previous = cpuSample();
  async sample(directory: string): Promise<HostMetrics> {
    const current = cpuSample(), elapsed = current.total - this.previous.total, idle = current.idle - this.previous.idle;
    const disk = await statfs(directory);
    const cpuPercent = elapsed > 0 ? Math.max(0, Math.min(100, 100 * (1 - idle / elapsed))) : 0;
    this.previous = current;
    return {cpuPercent, memoryUsedBytes: totalmem() - freemem(), memoryTotalBytes: totalmem(), diskFreeBytes: Number(disk.bavail) * Number(disk.bsize), loadAverage: Math.max(0, loadavg()[0]), cpuCount: Math.max(1,current.count)};
  }
}
