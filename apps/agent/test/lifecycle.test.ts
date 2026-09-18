import { afterEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HostMetrics, Lease, LogLine } from "@actions-fleet/protocol";
import type { RelayClient } from "../src/api.js";
import { RelayError } from "../src/api.js";
import { HostService } from "../src/service.js";
import { HostLock } from "../src/lock.js";
import { restoreSpools } from "../src/spool.js";
import { configuration, lease, raw } from "./fixtures.js";

const roots: string[] = [];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const quote = (value: string): string => `'${value.replaceAll("'","'\\''")}'`;

async function fixture(): Promise<{root:string;entrypoint:string;template:string;state:string}> {
  const root = await mkdtemp(join(tmpdir(),"fleet-lifecycle-test-"));roots.push(root);
  const template = join(root,"template with spaces"), state = join(root,"Library","Application Support","Actions Fleet"),entrypoint = join(root,"agent bundle.mjs");
  await mkdir(join(template,"bin"),{recursive:true,mode:0o700});await mkdir(state,{recursive:true,mode:0o700});
  await writeFile(join(template,".fleet-runner.json"),JSON.stringify({exportProtocol:1,admissionProtocol:1,target:`${process.platform === "darwin" ? "osx" : "linux"}-${process.arch}`}));
  for (const name of ["Runner.Listener","Runner.Worker"]) await writeFile(join(template,"bin",name),"#!/bin/sh\nexit 0\n",{mode:0o700});
  const script = `#!/bin/sh
export GITHUB_RUN_ID=123 GITHUB_RUN_ATTEMPT=2 GITHUB_SHA=${"a".repeat(40)}
/bin/bash $ACTIONS_RUNNER_HOOK_JOB_STARTED || exit 43
work=$(${quote(process.execPath)} -e ${quote(`const files=JSON.parse(Buffer.from(process.argv[1],'base64'));const settings=JSON.parse(Buffer.from(files['.runner'],'base64'));process.stdout.write(require('node:path').resolve(settings.WorkFolder ?? '_work'));`)} "$2") || exit 44
export GITHUB_WORKSPACE="$work/repository/repository" RUNNER_TEMP="$work/_temp"
mkdir -p "$GITHUB_WORKSPACE" "$RUNNER_TEMP/_runner_file_commands" || exit 44
export GITHUB_OUTPUT="$RUNNER_TEMP/_runner_file_commands/set_output_test"
/bin/bash -c 'printf "rustup_version=fixture\\n" >> $GITHUB_OUTPUT' || exit 44
cp "$GITHUB_OUTPUT" ${quote(join(root,"job-command-output.txt"))} || exit 44
${quote(process.execPath)} -e ${quote(`require('node:fs').writeFileSync(${JSON.stringify(join(root,"job-environment.json"))},JSON.stringify(process.env))`)}
printf '%s' ${quote(raw("real helper, hook and tailer"))} >> "$FLEET_LOG_PATH"
sleep 1
exit 0
`;
  await writeFile(join(template,"run.sh"),script,{mode:0o700});
  await build({entryPoints:[resolve("apps/agent/src/cli.ts")],outfile:entrypoint,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  return {root,entrypoint,template,state};
}

describe("native lifecycle",()=>{
  it("executes one isolated runner copy, verifies admission, exports logs, completes, and removes only its owned copy",async()=>{
    const {root,entrypoint,template,state} = await fixture();
    let claimed = false, admitted = false, completed = false;const uploaded: LogLine[] = [];
    let service: HostService;
    const api: RelayClient = {
      heartbeat:async()=>({mode:"dedicated"}),
      claim:async()=>{if (claimed) return null;claimed=true;return {...lease(),jobId:"hint-only",runId:122,runAttempt:1,headSha:"b".repeat(40)};},
      admission:async(_lease,input)=>{expect(input.headSha).toBe("a".repeat(40));admitted=true;return lease();},
      upload:async(_lease,lines)=>{uploaded.push(...lines);return lines.at(-1)!.sequence;},
      complete:async(_lease,code)=>{expect(code).toBe(0);completed=true;service.drain();},
    };
    service = new HostService(configuration(state,template),entrypoint,api,new HostLock(state,join(root,"lock"),0));
    const timeout = setTimeout(()=>service.drain(),12_000);
    try {await service.run();} finally {clearTimeout(timeout);}
    expect(claimed && admitted && completed).toBe(true);
    expect(uploaded.map(line=>line.line)).toEqual(["real helper, hook and tailer"]);
    expect(uploaded[0].runId).toBe(123); // GitHub assigned a different compatible job than the capacity hint.
    const environment = JSON.parse(await readFile(join(root,"job-environment.json"),"utf8"));
    expect(Object.values(environment)).not.toContain(configuration(state).token);
    expect(environment.FLEET_HOOK_CAPABILITY).toMatch(/^[a-f0-9]{64}$/);
    expect(environment.ACTIONS_RUNNER_HOOK_JOB_STARTED).toMatch(/^\/[A-Za-z0-9_./-]+$/);
    expect(environment.TMPDIR).toMatch(/\/lock\/t-[a-f0-9]{16}$/);
    expect(environment.TMPDIR).not.toContain("Application Support");
    expect(environment.GITHUB_WORKSPACE).toBe(join(environment.TMPDIR,"work","repository","repository"));
    expect(environment.RUNNER_TEMP).toBe(join(environment.TMPDIR,"work","_temp"));
    expect(environment.GITHUB_OUTPUT).not.toMatch(/\s/);
    expect(await readFile(join(root,"job-command-output.txt"),"utf8")).toBe("rustup_version=fixture\n");
    expect(environment.FLEET_LOG_PATH.startsWith(join(state,"spool")+"/")).toBe(true);
    await expect(readFile(environment.ACTIONS_RUNNER_HOOK_JOB_STARTED)).rejects.toMatchObject({code:"ENOENT"});
    await expect(readFile(environment.GITHUB_OUTPUT)).rejects.toMatchObject({code:"ENOENT"});
    await expect(stat(environment.TMPDIR)).rejects.toMatchObject({code:"ENOENT"});
    expect(await restoreSpools(join(state,"spool"))).toHaveLength(0);
    expect(await readFile(join(template,"run.sh"),"utf8")).toContain("GITHUB_RUN_ID");
    const status = JSON.parse(await readFile(join(state,"status.json"),"utf8"));
    expect(status.connectionStatus).toBe("stopped");expect(status.currentJob).toBeNull();
    expect(JSON.stringify(status)).not.toContain(configuration(state).token);
  },20_000);

  it("finishes active native work on relay loss and retains its unacknowledged spool for restart",async()=>{
    const {root,entrypoint,template,state} = await fixture();let claims = 0,failed = false,completed = false;
    let service: HostService;
    const api: RelayClient = {
      heartbeat:async()=>{if (failed) throw new RelayError(503);return {mode:"dedicated"};},
      claim:async()=>{claims++;return lease();},admission:async()=>lease(),
      upload:async()=>{failed=true;service.drain();throw new RelayError(503);},
      complete:async()=>{completed=true;},
    };
    service = new HostService(configuration(state,template),entrypoint,api,new HostLock(state,join(root,"lock"),0));
    const timeout = setTimeout(()=>service.drain(),12_000);
    try {await service.run();} finally {clearTimeout(timeout);}
    expect(failed).toBe(true);expect(claims).toBe(1);
    const spools = await restoreSpools(join(state,"spool"));
    expect(spools).toHaveLength(1);expect(spools[0].batch()[0].sequence).toBe(1);
    expect((await spools[0].result())?.exitCode).toBe(0);
    // Completion may have raced the upload failure, but replay remains durable
    // in either order and never starts a second native runner.
    expect(await readFile(join(root,"job-environment.json"),"utf8")).toContain("GITHUB_RUN_ID");
  },20_000);

  it("runs no contributed work when authoritative admission denies the assigned attempt",async()=>{
    const {root,entrypoint,template,state} = await fixture();let uploads = 0;let service: HostService;
    const api: RelayClient = {
      heartbeat:async()=>({mode:"dedicated"}),claim:async()=>lease(),admission:async()=>null,
      upload:async()=>{uploads++;return 0;},complete:async(_lease,code)=>{expect(code).toBe(43);service.drain();},
    };
    service = new HostService(configuration(state,template),entrypoint,api,new HostLock(state,join(root,"lock"),0));
    const timeout = setTimeout(()=>service.drain(),12_000);
    try {await service.run();} finally {clearTimeout(timeout);}
    expect(uploads).toBe(0);
    await expect(readFile(join(root,"job-environment.json"))).rejects.toMatchObject({code:"ENOENT"});
    expect(await restoreSpools(join(state,"spool"))).toHaveLength(0);
    const status = JSON.parse(await readFile(join(state,"status.json"),"utf8"));
    expect(status.error).toMatch(/review/);
  },20_000);
});
