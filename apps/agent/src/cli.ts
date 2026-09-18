import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { resolve, join } from "node:path";
import { lstat } from "node:fs/promises";
import { platformSchema, architectureSchema } from "@actions-fleet/protocol";
import { enroll } from "./api.js";
import { defaultStateDirectory, loadConfiguration, relayUrl, saveConfiguration, VERSION } from "./config.js";
import { isMissing, privateDirectory, readJson, writeJson } from "./files.js";
import { validateRunnerTemplate, runnerHelper } from "./runner.js";
import { admissionHook, HostService } from "./service.js";
import { generateServiceFiles } from "./service-files.js";

async function main(): Promise<void> {
  const [major,minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 14)) throw new Error("Node.js 22.14 or later is required");
  const {values,positionals} = parseArgs({allowPositionals:true,strict:true,options:{
    "state-dir":{type:"string"},"relay-url":{type:"string"},name:{type:"string"},
    "runner-directory":{type:"string"},label:{type:"string",multiple:true},help:{type:"boolean"},version:{type:"boolean"},
  }});
  const command = positionals[0];
  if (values.version) {process.stdout.write(`${VERSION}\n`);return;}
  if (values.help || !command) {
    process.stdout.write(`Actions Fleet host agent ${VERSION}

  enroll --relay-url HTTPS_ORIGIN --name NAME --runner-directory PATH [--label LABEL]
  run              Run the host service in the foreground
  status           Print local nonsecret status as JSON
  pause            Pause admission locally; active work finishes
  resume           Clear local pause and follow dashboard mode
  service-files    Generate a user service definition without activating it

All commands accept --state-dir PATH. Enrollment reads a one-use token from
standard input or FLEET_ENROLLMENT_TOKEN. Use the patched, unregistered runner
template built by this repository. Native macOS and Linux are supported.
`);return;
  }
  if (command === "internal-runner") {await runnerHelper();return;}
  if (command === "internal-admission") {await admissionHook();return;}
  platformSchema.parse(process.platform); architectureSchema.parse(process.arch);
  const stateDirectory = resolve(values["state-dir"] ?? defaultStateDirectory());
  const entrypoint = resolve(process.argv[1]);
  if (command === "enroll") {
    if (!values["relay-url"] || !values.name || !values["runner-directory"]) throw new Error("Enrollment requires --relay-url, --name, and --runner-directory");
    await privateDirectory(stateDirectory);
    try {await lstat(join(stateDirectory,"config.json"));throw new Error("This state directory is already enrolled; revoke its old identity before creating a new enrollment");} catch(error) {if (!isMissing(error)) throw error;}
    const relay = relayUrl(values["relay-url"]);
    const runnerDirectory = resolve(values["runner-directory"]);
    await validateRunnerTemplate(runnerDirectory);
    const family = process.platform === "darwin" ? "macos" : "linux";
    const labels = [...new Set([`fleet-${family}-${process.arch}`,...(values.label ?? [])])];
    if (labels.length > 30 || labels.some(label=>!/^[a-zA-Z0-9_.-]{1,128}$/.test(label))) throw new Error("Labels must use letters, digits, underscore, dot, or hyphen (maximum 30)");
    let token = process.env.FLEET_ENROLLMENT_TOKEN;
    delete process.env.FLEET_ENROLLMENT_TOKEN;
    if (!token) {
      if (process.stdin.isTTY) process.stderr.write("One-use enrollment token: ");
      const input = createInterface({input:process.stdin,terminal:false});
      try {for await (const line of input) {token = line.trim();break;}} finally {input.close();}
    }
    if (!token) throw new Error("Enrollment token was not supplied");
    const platform = platformSchema.parse(process.platform), architecture = architectureSchema.parse(process.arch);
    const registered = await enroll(relay,{token,name:values.name,platform,architecture,labels});
    await saveConfiguration({relayUrl:relay,hostId:registered.hostId,token:registered.token,name:values.name,platform,architecture,labels,runnerDirectory,stateDirectory,maxSpoolBytes:256*1024*1024,sharedMaxCpuPercent:50,sharedMinFreeMemoryBytes:4*1024*1024*1024});
    process.stdout.write(`Enrolled ${values.name}. Dashboard mode: ${registered.mode}. Start with the run command.\n`);
    return;
  }
  if (command === "status") {
    const status = await readJson(join(stateDirectory,"status.json"));
    process.stdout.write(`${JSON.stringify(status,null,2)}\n`);return;
  }
  if (command === "pause" || command === "resume") {
    await loadConfiguration(stateDirectory);
    await writeJson(join(stateDirectory,"control.json"),{paused:command === "pause"});
    process.stdout.write(command === "pause" ? "Local admission paused. Active work may finish.\n" : "Local pause cleared. The dashboard mode applies.\n");return;
  }
  const config = await loadConfiguration(stateDirectory);
  if (command === "service-files") {
    const path = await generateServiceFiles(stateDirectory,entrypoint);
    process.stdout.write(`Generated ${path}\nNo service was installed or started. See apps/agent/README.md for activation commands.\n`);return;
  }
  if (command === "run") {await new HostService(config,entrypoint).run();return;}
  throw new Error("Unknown command; use --help");
}

main().catch(error => {
  // Never dump API response bodies, enrollment tokens, JIT configuration, or
  // arbitrary exceptions containing request headers.
  const message = error instanceof Error ? error.message : "Agent operation failed";
  process.stderr.write(`Actions Fleet: ${message}\n`);
  process.exitCode = 1;
});
