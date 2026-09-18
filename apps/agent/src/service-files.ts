import { join } from "node:path";
import { privateDirectory, atomicWrite } from "./files.js";

const xml = (value: string): string => value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const systemd = (value: string): string => `"${value.replaceAll("\\","\\\\").replaceAll('"','\\"').replaceAll("%","%%").replaceAll("$","$$").replaceAll("\n","\\n")}"`;

export function launchdDefinition(node: string, entrypoint: string, stateDirectory: string, path: string): string {
  // Match GitHub's runner service: launchd Background/Standard also throttle
  // Dedicated work. Shared priority is applied to the runner, not the host agent.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.actions-fleet.agent</string>
  <key>ProgramArguments</key><array>${[node,entrypoint,"run","--state-dir",stateDirectory].map(value=>`<string>${xml(value)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string><key>ExitTimeOut</key><integer>7200</integer>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>StandardOutPath</key><string>${xml(join(stateDirectory,"service.stdout.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(stateDirectory,"service.stderr.log"))}</string>
</dict></plist>
`;
}

export function systemdDefinition(node: string, entrypoint: string, stateDirectory: string, path: string): string {
  return `[Unit]
Description=Actions Fleet native host agent
After=network-online.target

[Service]
Type=simple
ExecStart=${[node,entrypoint,"run","--state-dir",stateDirectory].map(systemd).join(" ")}
Environment=${systemd(`PATH=${path}`)}
Restart=always
RestartSec=30
KillMode=process
TimeoutStopSec=infinity
UMask=0077

[Install]
WantedBy=default.target
`;
}

export async function generateServiceFiles(stateDirectory: string, entrypoint: string): Promise<string> {
  const directory = join(stateDirectory,"service");
  await privateDirectory(directory);
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const file = join(directory,process.platform === "darwin" ? "com.actions-fleet.agent.plist" : "actions-fleet-agent.service");
  await atomicWrite(file,process.platform === "darwin" ? launchdDefinition(process.execPath,entrypoint,stateDirectory,path) : systemdDefinition(process.execPath,entrypoint,stateDirectory,path));
  return file;
}
