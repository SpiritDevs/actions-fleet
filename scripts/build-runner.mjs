#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, mkdir, copyFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(path.join(root, 'patches/runner/version.json'), 'utf8'));
const source = path.join(root, '.cache/runner-src');
const target = process.platform === 'darwin' ? `osx-${process.arch}` : `linux-${process.arch}`;
if (!['osx-arm64','osx-x64','linux-arm64','linux-x64'].includes(target)) throw new Error('Build the runner on a supported Mac or Linux host.');
async function run(cmd, args, cwd = root) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {cwd, stdio:'inherit', env:{...process.env, DOTNET_CLI_TELEMETRY_OPTOUT:'1'}});
    child.on('error',reject); child.on('exit',code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}
await mkdir(path.dirname(source), {recursive:true});
try { await access(path.join(source, '.git')); }
catch { await run('git',['clone','--depth','1','--branch',version.tag,version.source,source]); }
const {execFileSync} = await import('node:child_process');
const head = execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim();
if (head !== version.commit) throw new Error(`Runner source revision differs from pinned ${version.commit}. Use a separate clean source cache.`);
const executionPath = path.join(source, 'src/Runner.Worker/ExecutionContext.cs');
let execution = await readFile(executionPath, 'utf8');
const anchor = '            _jobServerQueue.QueueWebConsoleLine(_record.Id, msg, totalLines);';
if (!execution.includes('FleetConsoleExporter.Write(')) {
  if (execution.split(anchor).length !== 2) throw new Error('Runner masking/export insertion point changed; review patch before building.');
  execution = execution.replace(anchor, `${anchor}\n            try\n            {\n                FleetConsoleExporter.Write(msg, Root.Id.ToString(), _record.Id.ToString(), GetGitHubContext("run_id"), GetGitHubContext("run_attempt"));\n            }\n            catch (Exception)\n            {\n                Trace.Warning("Fleet console export context unavailable; normal GitHub logs remain active.");\n            }`);
  await writeFile(executionPath, execution);
}
await copyFile(path.join(root,'patches/runner/FleetConsoleExporter.cs'),path.join(source,'src/Runner.Worker/FleetConsoleExporter.cs'));
await copyFile(path.join(root,'patches/runner/FleetAdmissionGate.cs'),path.join(source,'src/Runner.Worker/FleetAdmissionGate.cs'));
await copyFile(path.join(root,'patches/runner/FleetShellArguments.cs'),path.join(source,'src/Runner.Worker/Handlers/FleetShellArguments.cs'));
const scriptHandlerPath = path.join(source,'src/Runner.Worker/Handlers/ScriptHandler.cs');
let scriptHandler = await readFile(scriptHandlerPath,'utf8');
if (!scriptHandler.includes('FleetShellArguments.Format(')) {
  const anchor = '            var arguments = string.Format(argFormat, resolvedScriptPath);';
  if (scriptHandler.split(anchor).length !== 2) throw new Error('Runner shell argument insertion point changed; review path quoting before building.');
  scriptHandler = scriptHandler.replace(anchor,'#if OS_WINDOWS\n' + anchor + '\n#else\n            var arguments = FleetShellArguments.Format(argFormat, resolvedScriptPath);\n#endif');
  await writeFile(scriptHandlerPath,scriptHandler);
}
const stepsPath = path.join(source,'src/Runner.Worker/StepsRunner.cs');
let steps = await readFile(stepsPath,'utf8');
if (!steps.includes('new FleetAdmissionGate()')) {
  const insertions = [
    ['            while (jobContext.JobSteps.Count > 0 || !checkPostJobActions)', '            var fleetAdmission = new FleetAdmissionGate();\n            if (!fleetAdmission.CanRun(jobContext.JobSteps.Count > 0 ? jobContext.JobSteps.Peek() : null))\n            {\n                fleetAdmission.Reject(jobContext);\n                return;\n            }\n'],
    ['                Trace.Info($"Processing step: DisplayName=\'{step.DisplayName}\'");', '                if (!fleetAdmission.CanRun(step))\n                {\n                    fleetAdmission.Reject(jobContext, step);\n                    return;\n                }\n\n'],
    ['                Trace.Info($"Current state: job state = \'{jobContext.Result}\'");', '                if (!fleetAdmission.Observe(step))\n                {\n                    fleetAdmission.Reject(jobContext);\n                    return;\n                }\n\n'],
  ];
  for (const [anchor, insertion] of insertions) {
    if (steps.split(anchor).length !== 2) throw new Error('Runner mandatory admission insertion point changed; review patch before building.');
    steps = steps.replace(anchor,insertion + anchor);
  }
  await writeFile(stepsPath,steps);
}
const testsPath = path.join(source,'src/Test/L0/Worker/StepsRunnerL0.cs');
let tests = await readFile(testsPath,'utf8');
if (!tests.includes('public sealed partial class StepsRunnerL0')) {
  const anchor = 'public sealed class StepsRunnerL0';
  if (tests.split(anchor).length !== 2) throw new Error('Runner test harness changed; review mandatory-admission tests before building.');
  tests = tests.replace(anchor,'public sealed partial class StepsRunnerL0');
  await writeFile(testsPath,tests);
}
await copyFile(path.join(root,'patches/runner/FleetAdmissionGateL0.cs'),path.join(source,'src/Test/L0/Worker/FleetAdmissionGateL0.cs'));
await copyFile(path.join(root,'patches/runner/FleetShellArgumentsL0.cs'),path.join(source,'src/Test/L0/Worker/FleetShellArgumentsL0.cs'));
if (process.argv.includes('--patch-only')) { console.log(`Applied Fleet masked export, mandatory admission, and shell path quoting to ${source}`); process.exit(0); }
await run('bash',['./dev.sh','layout','Release',target],path.join(source,'src'));
const layout=path.join(source,'_layout');
await writeFile(path.join(layout,'.fleet-runner.json'),JSON.stringify({...version,target,builtAt:new Date().toISOString()},null,2)+'\n');
console.log(`Patched runner template: ${layout}`);
