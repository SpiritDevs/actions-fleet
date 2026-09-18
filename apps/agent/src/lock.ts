import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { isMissing, privateDirectory, readJson, writeJson } from "./files.js";

// Fixed across state directories and OS users. The kernel listener serializes
// acquisition; the private record also blocks a surviving runner after a crash.
export const HOST_PORT = 47381;
const HOST_LOCK_DIRECTORY = "/tmp/actions-fleet-native-host";
interface LockRecord {nonce: string; pid: number; activePid?: number; stateDirectory: string; hookFiles?: string[]; temporaryDirectories?: string[]}
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try { process.kill(pid,0); return true; } catch(error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export class HostLock {
  private readonly record: LockRecord;
  private server?: Server;
  private owned = false;
  constructor(stateDirectory: string, private readonly directory = HOST_LOCK_DIRECTORY, private readonly port = HOST_PORT) {
    this.record = {nonce:randomUUID(),pid:process.pid,stateDirectory};
  }
  get url(): string {
    const address = this.server?.address();
    if (!address || typeof address === "string") throw new Error("Host lock is not held");
    return `http://127.0.0.1:${address.port}`;
  }
  async acquire(handler: (req: IncomingMessage,res: ServerResponse) => void): Promise<void> {
    const server = createServer(handler);
    server.requestTimeout = 20_000; server.headersTimeout = 10_000;
    await new Promise<void>((resolve,reject) => {
      server.once("error",reject);
      server.listen({host:"127.0.0.1",port:this.port,exclusive:true},() => {server.off("error",reject);resolve();});
    }).catch(() => { throw new Error("Another Actions Fleet agent already owns this physical host (or its local port is occupied)"); });
    this.server = server;
    try {
      await privateDirectory(this.directory);
      let previous: LockRecord | undefined;
      try { previous = await readJson<LockRecord>(join(this.directory,"owner.json")); } catch(error) {if (!isMissing(error)) throw error;}
      if (previous?.activePid && processAlive(previous.activePid)) throw new Error("A runner from the previous agent is still active; wait for it to finish before restarting");
      if (previous) await this.removeRecordedResources(previous);
      await writeJson(join(this.directory,"owner.json"),this.record);
      this.owned = true;
    } catch(error) { await this.closeServer(); throw error; }
  }
  async createHook(contents: string): Promise<string> {
    if (!this.owned) throw new Error("Host lock is not held");
    // The official runner passes this script path to its shell unquoted. The
    // private host-lock directory has a fixed shell-safe production path.
    if (!/^\/[A-Za-z0-9_./-]+$/.test(this.directory)) throw new Error("Host hook directory must have a shell-safe path without spaces");
    await privateDirectory(this.directory);
    const filename = `hook-${randomUUID()}.sh`, path = join(this.directory,filename);
    await writeFile(path,contents,{mode:0o700,flag:"wx"});
    this.record.hookFiles = [...(this.record.hookFiles ?? []),filename];
    try {await writeJson(join(this.directory,"owner.json"),this.record);}
    catch(error) {
      this.record.hookFiles = this.record.hookFiles.filter(name=>name !== filename);
      await rm(path,{force:true});throw error;
    }
    return path;
  }
  async createTemporaryDirectory(): Promise<string> {
    if (!this.owned) throw new Error("Host lock is not held");
    await privateDirectory(this.directory);
    // Keep TMPDIR short: Darwin Unix sockets allow only 104 bytes including the
    // terminator. The default state directory plus a lease hash already exceeds it.
    const filename = `t-${randomBytes(8).toString("hex")}`, path = join(this.directory,filename);
    await mkdir(path,{mode:0o700});
    this.record.temporaryDirectories = [...(this.record.temporaryDirectories ?? []),filename];
    try {await writeJson(join(this.directory,"owner.json"),this.record);}
    catch(error) {
      this.record.temporaryDirectories = this.record.temporaryDirectories.filter(name=>name !== filename);
      await rm(path,{recursive:true,force:true});throw error;
    }
    return path;
  }
  private async removeRecordedResources(record: LockRecord): Promise<void> {
    for (const filename of record.hookFiles ?? []) {
      if (!/^hook-[0-9a-f-]{36}\.sh$/.test(filename)) throw new Error("Refusing cleanup of an invalid recorded hook filename");
      const path = join(this.directory,filename);
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error("Refusing cleanup of an unowned or linked hook file");
        await rm(path,{force:true});
      } catch(error) {if (!isMissing(error)) throw error;}
    }
    for (const filename of record.temporaryDirectories ?? []) {
      if (!/^t-[0-9a-f]{16}$/.test(filename)) throw new Error("Refusing cleanup of an invalid recorded temporary directory");
      const path = join(this.directory,filename);
      try {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error("Refusing cleanup of an unowned or linked temporary directory");
        await rm(path,{recursive:true,force:true});
      } catch(error) {if (!isMissing(error)) throw error;}
    }
  }
  async trackChild(pid: number): Promise<void> {
    if (!this.owned) throw new Error("Host lock is not held");
    this.record.activePid = pid;
    await writeJson(join(this.directory,"owner.json"),this.record);
  }
  async clearChild(): Promise<void> {
    if (this.owned) await this.removeRecordedResources(this.record);
    delete this.record.hookFiles;
    delete this.record.temporaryDirectories;
    delete this.record.activePid;
    if (this.owned) await writeJson(join(this.directory,"owner.json"),this.record);
  }
  private async closeServer(): Promise<void> {
    if (!this.server) return;
    const server = this.server; this.server = undefined;
    server.closeIdleConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  async release(): Promise<void> {
    if (this.owned) {
      const saved = await readJson<LockRecord>(join(this.directory,"owner.json"));
      if (saved.nonce === this.record.nonce && !this.record.activePid) {
        await this.removeRecordedResources(this.record);
        await rm(join(this.directory,"owner.json"),{force:true});
      }
      this.owned = false;
    }
    await this.closeServer();
  }
}
