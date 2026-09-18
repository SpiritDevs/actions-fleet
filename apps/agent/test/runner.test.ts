import { describe, expect, it } from "vitest";
import { validateJitConfiguration, withRunnerWorkDirectory } from "../src/runner.js";
import { jit } from "./fixtures.js";

describe("runner work directory",()=>{
  it("overrides only WorkFolder while preserving credentials and validated runner settings",()=>{
    const settings = {AgentId:"42",AgentName:"test-runner",ephemeral:true,disableUpdate:true,WorkFolder:"_work",workFolder:"old",WORKFOLDER:"another",UseV2Flow:"True",ServerUrl:"https://github.example"};
    const files = {".runner":Buffer.from(JSON.stringify(settings)).toString("base64"),".credentials":Buffer.from("fake credentials").toString("base64"),".credentials_rsaparams":Buffer.from("fake key").toString("base64")};
    const encoded = Buffer.from(JSON.stringify(files)).toString("base64");
    const work = "/tmp/actions-fleet-native-host/t-0123456789abcdef/work";
    const updated = withRunnerWorkDirectory(encoded,"test-runner",work);
    validateJitConfiguration(updated,"test-runner");
    const decoded = JSON.parse(Buffer.from(updated,"base64").toString("utf8"));
    expect(Object.keys(decoded)).toEqual(Object.keys(files));
    expect(decoded[".credentials"]).toBe(files[".credentials"]);
    expect(decoded[".credentials_rsaparams"]).toBe(files[".credentials_rsaparams"]);
    expect(JSON.parse(Buffer.from(decoded[".runner"],"base64").toString("utf8"))).toEqual({AgentId:"42",AgentName:"test-runner",ephemeral:true,disableUpdate:true,WorkFolder:work,UseV2Flow:"True",ServerUrl:"https://github.example"});
  });

  it("rejects unvalidated JIT registrations and unsafe work paths",()=>{
    const work = "/tmp/owned/work";
    for (const encoded of ["invalid",jit("another-runner"),jit("test-runner",{ephemeral:false}),jit("test-runner",{disableUpdate:false})]) {
      expect(()=>withRunnerWorkDirectory(encoded,"test-runner",work)).toThrow(/Relay JIT/);
    }
    for (const path of ["relative/work","/tmp/path with spaces/work","/tmp/tab\t/work","/tmp/path\n/work"]) {
      expect(()=>withRunnerWorkDirectory(jit(),"test-runner",path)).toThrow(/work directory/);
    }
  });
});
