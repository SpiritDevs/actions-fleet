import { homedir } from "node:os";
import { resolve, join, isAbsolute } from "node:path";
import { lstat } from "node:fs/promises";
import { z } from "zod";
import { architectureSchema, platformSchema, type AgentConfiguration } from "@actions-fleet/protocol";
import { privateDirectory, readJson, writeJson } from "./files.js";

export const VERSION = "0.1.0";
export function defaultStateDirectory(): string {
  return process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "Actions Fleet") : join(homedir(), ".local", "state", "actions-fleet");
}

export function relayUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Relay URL must be an HTTPS origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

export const configurationSchema = z.object({
  relayUrl: z.string().transform(relayUrl), hostId: z.string().min(1), token: z.string().min(20), name: z.string().min(1).max(128),
  platform: platformSchema, architecture: architectureSchema,
  labels: z.array(z.string().min(1).max(128)).max(30),
  runnerDirectory: z.string().refine(isAbsolute), stateDirectory: z.string().refine(isAbsolute),
  maxSpoolBytes: z.number().int().min(4 * 1024 * 1024).max(4 * 1024 * 1024 * 1024),
  sharedMaxCpuPercent: z.number().min(1).max(100), sharedMinFreeMemoryBytes: z.number().int().nonnegative(),
});

export async function saveConfiguration(config: AgentConfiguration): Promise<void> {
  const validated = configurationSchema.parse(config);
  await privateDirectory(validated.stateDirectory);
  await writeJson(join(validated.stateDirectory, "config.json"), validated);
}

export async function loadConfiguration(stateDirectory: string): Promise<AgentConfiguration> {
  await privateDirectory(stateDirectory);
  const path = join(stateDirectory, "config.json");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Agent configuration must be a private, user-owned regular file (0600)");
  }
  const config = configurationSchema.parse(await readJson(path));
  if (resolve(config.stateDirectory) !== resolve(stateDirectory)) throw new Error("Configuration state directory does not match its location");
  if (config.platform !== process.platform || config.architecture !== process.arch) throw new Error("Enrollment belongs to a different host platform or architecture");
  return config;
}
