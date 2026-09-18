import { constants } from "node:fs";
import { open, mkdir, rename, rm, lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("State directory must be a real directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("State directory belongs to another user");
  if ((stat.mode & 0o077) !== 0) throw new Error("State directory permissions must be 0700; restrict access before continuing");
}

export async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `.fleet-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value)}\n`);
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
