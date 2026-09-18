import type { HostMetrics, HostMode } from "@actions-fleet/protocol";

export interface AdmissionState {
  mode: HostMode; locallyPaused: boolean; relayHealthy: boolean; active: boolean; draining: boolean;
  metrics: HostMetrics; sharedMaxCpuPercent: number; sharedMinFreeMemoryBytes: number;
  spoolAvailableBytes: number;
}

export function admissionReason(state: AdmissionState): string | null {
  if (state.draining) return "Service is draining";
  if (!state.relayHealthy) return "Relay connection is unavailable";
  if (state.locallyPaused || state.mode === "paused") return "Host is paused";
  if (state.active) return "A job already owns this host";
  if (state.metrics.diskFreeBytes < 1024 * 1024 * 1024) return "Less than 1 GiB of free disk space";
  if (state.spoolAvailableBytes < 1024 * 1024) return "Waiting for log spool capacity";
  if (state.mode === "shared") {
    if (state.metrics.cpuPercent > state.sharedMaxCpuPercent) return "Shared mode is waiting for lower CPU usage";
    if (state.metrics.memoryTotalBytes - state.metrics.memoryUsedBytes < state.sharedMinFreeMemoryBytes) return "Shared mode is waiting for free memory";
  }
  return null;
}
