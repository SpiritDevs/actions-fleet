import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
});
