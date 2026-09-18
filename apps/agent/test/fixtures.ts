import type { AgentConfiguration, HostMetrics, Lease } from "@actions-fleet/protocol";

export const metrics: HostMetrics = {cpuPercent:10,memoryUsedBytes:8e9,memoryTotalBytes:32e9,diskFreeBytes:100e9,loadAverage:1,cpuCount:12};
export function jit(name = "test-runner", settings: Record<string,unknown> = {}): string {
  return Buffer.from(JSON.stringify({".runner":Buffer.from(JSON.stringify({agentName:name,ephemeral:true,disableUpdate:true,...settings})).toString("base64")})).toString("base64");
}
export function lease(): Lease {
  return {id:"test-lease",jobId:"1234",repository:"owner/repository",runId:123,runAttempt:2,headSha:"a".repeat(40),runnerName:"test-runner",encodedJitConfig:jit(),expiresAt:new Date(Date.now()+300_000).toISOString()};
}
export function configuration(stateDirectory: string, runnerDirectory = "/tmp/runner-template"): AgentConfiguration {
  return {relayUrl:"https://relay.example",hostId:"test-host",token:"secret-management-token-123456789",name:"Test host",platform:process.platform as "darwin"|"linux",architecture:process.arch as "arm64"|"x64",labels:["fleet-macos-arm64"],runnerDirectory,stateDirectory,maxSpoolBytes:8*1024*1024,sharedMaxCpuPercent:50,sharedMinFreeMemoryBytes:4e9};
}
export function raw(line = "masked *** output"): string {
  return JSON.stringify({timestamp:"2026-09-18T21:22:22.5903370Z",runId:123,runAttempt:2,jobId:"05171998-88ea-5521-b4a5-3e2d89039030",stepId:"step-1",line})+"\n";
}
