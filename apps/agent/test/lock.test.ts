import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostLock } from "../src/lock.js";
import { writeJson } from "../src/files.js";

const locks: HostLock[] = [], directories: string[] = [];
afterEach(async()=>{
  for (const lock of locks.splice(0)) await lock.release();
  await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));
});
describe("physical host ownership",()=>{
  it("prevents a second agent with a different state directory from acquiring the host",async()=>{
    const root = await mkdtemp(join(tmpdir(),"fleet-lock-test-"));directories.push(root);
    const first = new HostLock("/state/one",root,0);locks.push(first);
    await first.acquire((_req,res)=>res.end());
    const second = new HostLock("/state/two",root,Number(new URL(first.url).port));locks.push(second);
    await expect(second.acquire((_req,res)=>res.end())).rejects.toThrow(/already owns/);
  });
  it("fails closed while an orphan runner PID is still alive",async()=>{
    const root = await mkdtemp(join(tmpdir(),"fleet-lock-test-"));directories.push(root);
    await writeJson(join(root,"owner.json"),{nonce:"old",pid:9999999,activePid:process.pid,stateDirectory:"/old"});
    const lock = new HostLock("/new",root,0);locks.push(lock);
    await expect(lock.acquire((_req,res)=>res.end())).rejects.toThrow(/still active/);
  });
  it("creates private shell-safe hooks and cleans only its recorded files",async()=>{
    const root = await mkdtemp(join(tmpdir(),"fleet-lock-test-"));directories.push(root);
    const lock = new HostLock("/Library/Application Support/Actions Fleet",root,0);locks.push(lock);
    await lock.acquire((_req,res)=>res.end());
    const unrelated = join(root,"unrelated.sh");await writeFile(unrelated,"keep");
    const hook = await lock.createHook("#!/bin/sh\nexit 0\n");
    expect(hook).toMatch(/^\/[A-Za-z0-9_./-]+$/);
    expect((await stat(hook)).mode & 0o777).toBe(0o700);
    await lock.clearChild();
    await expect(readFile(hook)).rejects.toMatchObject({code:"ENOENT"});
    expect(await readFile(unrelated,"utf8")).toBe("keep");
  });
  it("removes a recorded stale hook only after the previous runner is gone",async()=>{
    const root = await mkdtemp(join(tmpdir(),"fleet-lock-test-"));directories.push(root);
    const filename = "hook-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.sh";
    await writeFile(join(root,filename),"#!/bin/sh\nexit 0\n",{mode:0o700});
    await writeJson(join(root,"owner.json"),{nonce:"old",pid:9999999,stateDirectory:"/old",hookFiles:[filename]});
    const lock = new HostLock("/new",root,0);locks.push(lock);
    await lock.acquire((_req,res)=>res.end());
    await expect(readFile(join(root,filename))).rejects.toMatchObject({code:"ENOENT"});
  });
  it("gives jobs a private short TMPDIR that supports nested native Unix sockets",async()=>{
    const root = await mkdtemp("/tmp/fleet-lock-test-");directories.push(root);
    const lock = new HostLock("/Users/test/Library/Application Support/Actions Fleet",root,0);locks.push(lock);
    await lock.acquire((_req,res)=>res.end());
    const temporary = await lock.createTemporaryDirectory();
    expect((await stat(temporary)).mode & 0o777).toBe(0o700);
    const script = `
      const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), net = require('node:net');
      (async()=>{
        const directory = await fs.mkdtemp(path.join(os.tmpdir(),'pathway-niri-test-'));
        const socket = path.join(directory,'ipc');
        const server = net.createServer();
        await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
        process.stdout.write(socket);
        await new Promise(resolve=>server.close(resolve));
      })().catch(error=>{console.error(error);process.exitCode=1;});
    `;
    const {stdout:socket} = await promisify(execFile)(process.execPath,["-e",script],{env:{PATH:process.env.PATH,TMPDIR:temporary},timeout:5000});
    expect(socket.startsWith(temporary+"/pathway-niri-test-")).toBe(true);
    expect(Buffer.byteLength(socket)).toBeLessThan(104);
    const saved = JSON.parse(await readFile(join(root,"owner.json"),"utf8"));
    expect(saved.temporaryDirectories).toEqual([temporary.split("/").at(-1)]);
    await lock.clearChild();
    await expect(stat(temporary)).rejects.toMatchObject({code:"ENOENT"});
  });
  it("preserves a live runner's temp data then recovers only recorded directories",async()=>{
    const root = await mkdtemp("/tmp/fleet-lock-test-");directories.push(root);
    const filename = "t-0123456789abcdef", temporary = join(root,filename), unrelated = join(root,"unrelated");
    await mkdir(temporary,{mode:0o700});await mkdir(unrelated,{mode:0o700});
    await writeFile(join(temporary,"owned"),"runner data");await writeFile(join(unrelated,"keep"),"keep");
    const previous = {nonce:"old",pid:9999999,activePid:process.pid,stateDirectory:"/old",temporaryDirectories:[filename]};
    await writeJson(join(root,"owner.json"),previous);
    const blocked = new HostLock("/new",root,0);locks.push(blocked);
    await expect(blocked.acquire((_req,res)=>res.end())).rejects.toThrow(/still active/);
    expect(await readFile(join(temporary,"owned"),"utf8")).toBe("runner data");
    await writeJson(join(root,"owner.json"),{...previous,activePid:9999999});
    const recovered = new HostLock("/new",root,0);locks.push(recovered);
    await recovered.acquire((_req,res)=>res.end());
    await expect(stat(temporary)).rejects.toMatchObject({code:"ENOENT"});
    expect(await readFile(join(unrelated,"keep"),"utf8")).toBe("keep");
  });
  it("refuses recovery cleanup through a substituted temporary-directory symlink",async()=>{
    const root = await mkdtemp("/tmp/fleet-lock-test-");directories.push(root);
    const target = await mkdtemp("/tmp/fleet-unrelated-test-");directories.push(target);
    const filename = "t-0123456789abcdef";
    await writeFile(join(target,"keep"),"keep");
    await symlink(target,join(root,filename));
    await writeJson(join(root,"owner.json"),{nonce:"old",pid:9999999,stateDirectory:"/old",temporaryDirectories:[filename]});
    const lock = new HostLock("/new",root,0);locks.push(lock);
    await expect(lock.acquire((_req,res)=>res.end())).rejects.toThrow(/linked temporary directory/);
    expect(await readFile(join(target,"keep"),"utf8")).toBe("keep");
  });
});
