import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { cpus } from "node:os";
import type { AgentConfiguration, HostMode, Lease } from "@actions-fleet/protocol";
import { isMissing, privateDirectory, readJson, writeJson } from "./files.js";
import { leaseKey, type LogSpool, type RunnerResult } from "./spool.js";
import type { HostLock } from "./lock.js";

export interface ActiveRunner {
  lease: Lease; child: ChildProcess; capability: string; admitted: boolean; closed: boolean;
  spool: LogSpool; exitCode?: number;
}
interface StartMessage {type:"start";directory:string;jitConfig:string;resultPath:string;shared:boolean}

export function validateJitConfiguration(encoded: string, expectedName: string): void {
  try {
    const files = JSON.parse(Buffer.from(encoded,"base64").toString("utf8")) as Record<string,string>;
    const runnerFile = Object.entries(files).find(([name])=>name.toLowerCase() === ".runner")?.[1];
    if (!runnerFile) throw new Error("Missing runner settings");
    const settings = Object.fromEntries(Object.entries(JSON.parse(Buffer.from(runnerFile,"base64").toString("utf8")) as Record<string,unknown>).map(([name,value])=>[name.toLowerCase(),value]));
    if (settings.agentname !== expectedName || settings.ephemeral !== true || settings.disableupdate !== true) throw new Error("Invalid ephemeral runner settings");
  } catch {throw new Error("Relay JIT registration must name this runner, be ephemeral, and disable automatic updates");}
}

export async function validateRunnerTemplate(directory: string): Promise<void> {
  if (!isAbsolute(directory)) throw new Error("Runner template directory must be absolute");
  const marker = await readJson<{exportProtocol?:number;admissionProtocol?:number;target?:string}>(join(directory,".fleet-runner.json"));
  if (marker.exportProtocol !== 1) throw new Error("Runner template does not contain the compatible masked-log exporter");
  if (marker.admissionProtocol !== 1) throw new Error("Runner template does not enforce mandatory admission before workflow steps");
  if (marker.target !== `${process.platform === "darwin" ? "osx" : "linux"}-${process.arch}`) throw new Error("Runner template target does not match this host's OS and architecture");
  for (const name of ["run.sh","bin/Runner.Listener","bin/Runner.Worker"]) {
    const item = await lstat(join(directory,name));
    if (!item.isFile() || !(item.mode & 0o111)) throw new Error(`Runner template is missing executable ${name}`);
  }
  for (const name of [".runner",".credentials",".credentials_rsaparams"]) {
    try { await lstat(join(directory,name)); throw new Error("Runner template must be unregistered; use a fresh patched runner build"); } catch(error) { if (!isMissing(error)) throw error; }
  }
}

export function runnerEnvironment(base: NodeJS.ProcessEnv, shared: boolean, cpuCount = cpus().length): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  // Do not inherit supervisor credentials, tokens, NODE_OPTIONS, shell startup
  // hooks, dynamic-loader overrides, or arbitrary environment from the agent.
  for (const name of ["PATH","HOME","USER","LOGNAME","SHELL","LANG","LC_ALL","LC_CTYPE","TZ","DEVELOPER_DIR"]) {
    if (base[name]) environment[name] = base[name];
  }
  environment.PATH ??= "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  environment.CI = "true";
  if (shared) {
    const threads = String(Math.max(1,Math.floor(cpuCount/2)));
    environment.CARGO_BUILD_JOBS = threads; environment.CMAKE_BUILD_PARALLEL_LEVEL = threads;
    environment.MAKEFLAGS = `-j${threads}`; environment.UV_THREADPOOL_SIZE = threads;
    environment.OMP_NUM_THREADS = threads;
  }
  return environment;
}

export async function prepareRunner(configuration: AgentConfiguration, lease: Lease): Promise<string> {
  await validateRunnerTemplate(configuration.runnerDirectory);
  const root = join(configuration.stateDirectory,"jobs");
  await privateDirectory(root);
  const destination = join(root,leaseKey(lease.id));
  await mkdir(destination,{mode:0o700}); // Refuse re-execution of an existing lease.
  await writeJson(join(destination,".fleet-owned.json"),{leaseId:lease.id});
  const excluded = new Set(["_work","_diag",".runner",".credentials",".credentials_rsaparams",".env",".path",".service",".fleet-owned.json"]);
  for (const entry of await readdir(configuration.runnerDirectory,{withFileTypes:true})) {
    if (excluded.has(entry.name)) continue;
    await cp(join(configuration.runnerDirectory,entry.name),join(destination,entry.name),{recursive:true,errorOnExist:true,force:false,dereference:false});
  }
  await privateDirectory(join(destination,"fleet-temp"));
  return destination;
}

export async function cleanupRunner(stateDirectory: string, directory: string, leaseId: string): Promise<void> {
  const expected = join(resolve(stateDirectory),"jobs",leaseKey(leaseId));
  if (resolve(directory) !== expected) throw new Error("Refusing cleanup outside this lease's owned directory");
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing cleanup through a symbolic link");
    const marker = await readJson<{leaseId:string}>(join(directory,".fleet-owned.json"));
    if (marker.leaseId !== leaseId) throw new Error("Runner directory ownership does not match lease");
    await rm(directory,{recursive:true,force:true});
  } catch(error) { if (!isMissing(error)) throw error; }
}

export async function startRunner(configuration: AgentConfiguration, lease: Lease, spool: LogSpool, mode: HostMode, lock: HostLock, entrypoint: string): Promise<ActiveRunner> {
  if (Date.parse(lease.expiresAt) <= Date.now()) throw new Error("Runner registration lease expired before startup");
  validateJitConfiguration(lease.encodedJitConfig,lease.runnerName);
  const capability = randomBytes(32).toString("hex");
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const hookPath = await lock.createHook(`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entrypoint)} internal-admission\n`);
  const environment = runnerEnvironment(process.env,mode === "shared");
  Object.assign(environment,{
    TMPDIR:join(spool.jobDirectory,"fleet-temp"),
    ACTIONS_RUNNER_HOOK_JOB_STARTED:hookPath,
    FLEET_REQUIRE_ADMISSION:"1",
    FLEET_HOOK_URL:`${lock.url}/admission`,FLEET_HOOK_CAPABILITY:capability,
    FLEET_LOG_PATH:spool.sourcePath,FLEET_LOG_MAX_BYTES:String(spool.sourceLimit),
    FLEET_LOG_ERROR_PATH:`${spool.sourcePath}.error`,
  });
  // The helper cannot execute until its PID is persisted in the host lock. If
  // the supervisor dies before start, IPC disconnect makes the helper exit.
  const child = fork(entrypoint,["internal-runner"],{env:environment,execArgv:[],detached:true,stdio:["ignore","ignore","ignore","ipc"]});
  const active: ActiveRunner = {lease,child,capability,admitted:false,closed:false,spool};
  child.on("exit",code => {active.closed = true; active.exitCode = code ?? -1;});
  child.on("error",() => {active.closed = true;active.exitCode = -1;});
  if (!child.pid) throw new Error("Could not launch the runner supervisor");
  try {
    await lock.trackChild(child.pid);
    if (Date.parse(lease.expiresAt) <= Date.now()) throw new Error("Runner registration lease expired while preparing the host");
    await new Promise<void>((resolve,reject) => child.send({type:"start",directory:spool.jobDirectory,jitConfig:lease.encodedJitConfig,resultPath:spool.resultPath,shared:mode === "shared"} satisfies StartMessage,error => error ? reject(error) : resolve()));
  } catch(error) { child.kill("SIGTERM"); throw error; }
  return active;
}

// Only used by the child helper spawned above. It gets no fleet management token.
export async function runnerHelper(): Promise<void> {
  if (!process.send) throw new Error("Runner helper requires an agent IPC channel");
  let started = false;
  const timeout = setTimeout(() => process.exit(1),30_000);
  process.on("disconnect",() => {if (!started) process.exit(1);});
  process.once("message",async (message: StartMessage) => {
    if (message?.type !== "start" || !isAbsolute(message.directory) || !isAbsolute(message.resultPath)) process.exit(1);
    started = true; clearTimeout(timeout);
    const args = [join(message.directory,"run.sh"),"--jitconfig",message.jitConfig];
    const command = message.shared ? "/usr/bin/nice" : args.shift()!;
    if (message.shared) args.unshift("-n","10");
    const runner = spawn(command,args,{cwd:message.directory,env:process.env,stdio:["ignore","ignore","ignore"]});
    let recorded = false;
    const finish = async (code: number, error?: string): Promise<void> => {
      if (recorded) return; recorded = true;
      const result: RunnerResult = {exitCode:code,completedAt:new Date().toISOString(),...(error ? {error} : {})};
      try { await writeJson(message.resultPath,result); } catch { process.exitCode = 1; }
      if (process.connected) process.disconnect?.();
    };
    runner.once("error",() => {void finish(-1,"Runner process could not be started");});
    runner.once("exit",(code,signal) => {void finish(code ?? -1,signal ? `Runner exited after ${signal}` : undefined);});
    // A normal supervisor shutdown drains this process. Signals delivered to
    // this helper's tracked process group are only used for explicit force stop.
  });
}
