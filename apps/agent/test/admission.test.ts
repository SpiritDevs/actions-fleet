import { describe, expect, it } from "vitest";
import { admissionReason, type AdmissionState } from "../src/admission.js";
import { runnerEnvironment, validateJitConfiguration } from "../src/runner.js";
import { metrics, jit } from "./fixtures.js";
import { createServer } from "node:http";
import { admissionHook } from "../src/service.js";

const ready: AdmissionState = {mode:"dedicated",locallyPaused:false,relayHealthy:true,active:false,draining:false,metrics,sharedMaxCpuPercent:50,sharedMinFreeMemoryBytes:4e9,spoolAvailableBytes:1e8};
describe("native admission",()=>{
  it("requires one free host slot, relay health, disk and replay capacity",()=>{
    expect(admissionReason(ready)).toBeNull();
    for (const patch of [{active:true},{draining:true},{relayHealthy:false},{locallyPaused:true},{mode:"paused" as const},{spoolAvailableBytes:0},{metrics:{...metrics,diskFreeBytes:10}}]) expect(admissionReason({...ready,...patch})).not.toBeNull();
  });
  it("shared mode waits for CPU and memory but dedicated mode is not throttled by these thresholds",()=>{
    const busy = {...metrics,cpuPercent:90,memoryUsedBytes:31e9};
    expect(admissionReason({...ready,metrics:busy})).toBeNull();
    expect(admissionReason({...ready,mode:"shared",metrics:busy})).toMatch(/CPU/);
    expect(admissionReason({...ready,mode:"shared",metrics:{...busy,cpuPercent:10}})).toMatch(/memory/);
  });
  it("uses available memory for Shared admission while retaining old-report and invalid-report fallbacks",()=>{
    const shared = {...ready,mode:"shared" as const,metrics:{...metrics,cpuPercent:10,memoryUsedBytes:31e9}};
    expect(admissionReason(shared)).toMatch(/memory/);
    expect(admissionReason({...shared,metrics:{...shared.metrics,memoryAvailableBytes:8e9}})).toBeNull();
    expect(admissionReason({...shared,metrics:{...shared.metrics,memoryAvailableBytes:4e9}})).toBeNull();
    expect(admissionReason({...shared,metrics:{...shared.metrics,memoryAvailableBytes:4e9-1}})).toMatch(/memory/);
    expect(admissionReason({...shared,metrics:{...metrics,memoryAvailableBytes:0}})).toMatch(/memory/);
    expect(admissionReason({...shared,metrics:{...shared.metrics,memoryAvailableBytes:8e9,cpuPercent:51}})).toMatch(/CPU/);
    for (const memoryAvailableBytes of [-1,Infinity,NaN,shared.metrics.memoryTotalBytes+1]) {
      expect(admissionReason({...shared,metrics:{...shared.metrics,memoryAvailableBytes}})).toMatch(/memory/);
    }
  });
  it("does not pass supervisor credentials or Node/shell injection variables to jobs",()=>{
    const environment = runnerEnvironment({PATH:"/usr/bin",HOME:"/home/test",FLEET_TOKEN:"secret",NPM_TOKEN:"secret",GITHUB_TOKEN:"secret",NODE_OPTIONS:"--require bad",BASH_ENV:"bad",DYLD_INSERT_LIBRARIES:"bad"},true,12);
    expect(environment).toEqual({PATH:"/usr/bin",HOME:"/home/test",CI:"true",CARGO_BUILD_JOBS:"6",CMAKE_BUILD_PARALLEL_LEVEL:"6",MAKEFLAGS:"-j6",UV_THREADPOOL_SIZE:"6",OMP_NUM_THREADS:"6"});
  });
  it("rejects shared, renamed or automatically updating JIT runners",()=>{
    expect(()=>validateJitConfiguration(jit(),"test-runner")).not.toThrow();
    expect(()=>validateJitConfiguration(jit("someone-else"),"test-runner")).toThrow();
    expect(()=>validateJitConfiguration(jit("test-runner",{ephemeral:false}),"test-runner")).toThrow();
    expect(()=>validateJitConfiguration(jit("test-runner",{disableUpdate:false}),"test-runner")).toThrow();
    expect(()=>validateJitConfiguration("invalid","test-runner")).toThrow();
    const normalizedRestJit = Buffer.from(JSON.stringify({".runner":Buffer.from(JSON.stringify({AgentId:"42",AgentName:"test-runner",ephemeral:true,disableUpdate:true,WorkFolder:"_work",UseV2Flow:"True"})).toString("base64")})).toString("base64");
    expect(()=>validateJitConfiguration(normalizedRestJit,"test-runner")).not.toThrow();
  });
  it("retries temporary assignment propagation but fails immediately on an explicit denial",async()=>{
    let calls = 0, deny = false;
    const server = createServer((_req,res)=>{
      calls++;
      res.writeHead(deny ? 403 : calls === 1 ? 503 : 200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({allowed:!deny && calls > 1}));
    });
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const environment = {FLEET_HOOK_URL:`http://127.0.0.1:${address.port}/admission`,FLEET_HOOK_CAPABILITY:"local-test-capability",GITHUB_RUN_ID:"123",GITHUB_RUN_ATTEMPT:"1",GITHUB_SHA:"a".repeat(40)};
    try {
      await admissionHook(environment);expect(calls).toBe(2);
      deny = true;calls = 0;
      await expect(admissionHook(environment)).rejects.toThrow(/denied/);
      expect(calls).toBe(1);
    } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
});
