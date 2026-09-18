#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const repository=process.env.FLEET_PILOT_REPOSITORY || 'SpiritDevs/actions-fleet';
if(!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
const nonce=randomBytes(5).toString('hex');
const directory=path.join(root,'.cache',`pilot-${nonce}`);
const runner=path.join(directory,'runner');
const template=path.resolve(process.env.FLEET_RUNNER_TEMPLATE || path.join(root,'.cache/runner-src/_layout'));
const marker=JSON.parse(await readFile(path.join(template,'.fleet-runner.json'),'utf8'));
if(marker.exportProtocol!==1 || marker.admissionProtocol!==1) throw new Error('Build the patched runner with mandatory admission support first.');
const admission=process.env.FLEET_PILOT_ADMISSION || 'allow';
if(!['allow','deny'].includes(admission)) throw new Error('FLEET_PILOT_ADMISSION must be allow or deny.');
await mkdir(directory,{recursive:true,mode:0o700});
await cp(template,runner,{recursive:true,filter:source=>!['.runner','.credentials','.credentials_rsaparams','_work','_diag'].includes(path.basename(source))});
const logs=path.join(directory,'console.ndjson');
const label=`fleet-pilot-${nonce}`;
function ghJson(args,input){ return JSON.parse(execFileSync('gh',args,{input:input?JSON.stringify(input):undefined,encoding:'utf8',stdio:['pipe','pipe','pipe']})); }
const registration=ghJson(['api',`repos/${repository}/actions/runners/generate-jitconfig`,'--input','-'],{name:label,runner_group_id:1,labels:['self-hosted',process.platform==='darwin'?'macOS':'Linux',process.arch==='arm64'?'ARM64':'X64',label],work_folder:'_work'});
const jit=JSON.parse(Buffer.from(registration.encoded_jit_config,'base64').toString('utf8'));
const settings=JSON.parse(Buffer.from(jit['.runner'],'base64').toString('utf8'));
settings.disableUpdate=true; settings.ephemeral=true;
jit['.runner']=Buffer.from(JSON.stringify(settings)).toString('base64');
const encodedJit=Buffer.from(JSON.stringify(jit)).toString('base64');
const hook=path.join(directory,'admission.sh');
await writeFile(hook,`#!/bin/bash\necho fleet-admission-probe-${admission}\nexit ${admission==='allow'?0:1}\n`,{mode:0o700});
let child;
try {
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','HOME','USER','LOGNAME','SHELL','LANG','LC_ALL','TMPDIR','TMP','TEMP'].includes(key)));
  child=spawn(path.join(runner,'run.sh'),['--jitconfig',encodedJit],{cwd:runner,stdio:['ignore','pipe','pipe'],env:{...env,FLEET_LOG_PATH:logs,FLEET_LOG_MAX_BYTES:'16777216',FLEET_REQUIRE_ADMISSION:'1',ACTIONS_RUNNER_HOOK_JOB_STARTED:hook}});
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  const completion=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});
  execFileSync('gh',['workflow','run','pilot.yml','--repo',repository,'--ref','main','-f',`runner_label=${label}`],{stdio:'pipe'});
  console.log(`Dispatched pilot to ${label}; local captured output: ${logs}`);
  const timeout=setTimeout(()=>child.kill('SIGINT'),12*60*1000);
  const result=await completion; clearTimeout(timeout);
  const lines=(await readFile(logs,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const text=lines.map(line=>line.line).join('\n');
  const expected=admission==='deny'?['fleet-admission-probe-deny']:['fleet-admission-probe-allow','Fleet pilot started','masked value: ***','quiet step resumed','Composite action console output','JavaScript action console output','pilot line 1999','fleet-pilot-final-tail'];
  const missing=expected.filter(value=>!text.includes(value));
  if(text.includes('fleet-pilot-synthetic-secret-314159')) throw new Error('Synthetic secret was not masked in exported console');
  if(missing.length) throw new Error(`Missing console markers: ${missing.join(', ')}`);
  if(admission==='deny' && ['Fleet pilot started','fleet-pilot-final-tail','Composite action console output','JavaScript action console output'].some(value=>text.includes(value))) throw new Error('A contributed step executed after denied admission.');
  const runIds=[...new Set(lines.map(line=>line.runId))];
  const summary={repository,runner:label,admission,lines:lines.length,steps:new Set(lines.map(line=>line.stepId)).size,runIds,result,verifiedAt:new Date().toISOString()};
  await writeFile(path.join(directory,'result.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(summary,null,2));
} finally {
  if(child && child.exitCode===null && child.signalCode===null) child.kill('SIGINT');
  try {execFileSync('gh',['api','--method','DELETE',`repos/${repository}/actions/runners/${registration.runner.id}`],{stdio:'pipe'});}catch{/* JIT runners remove themselves after one job. */}
}
