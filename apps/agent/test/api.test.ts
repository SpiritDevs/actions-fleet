import { afterEach, expect, it, vi } from "vitest";
import { heartbeatSchema } from "@actions-fleet/protocol";
import { ApiClient } from "../src/api.js";
import { configuration, metrics } from "./fixtures.js";

afterEach(() => vi.restoreAllMocks());

it("sends the fixed admission reason and explicitly clears it when ready", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({mode:"dedicated"}));
  const client = new ApiClient(configuration("/tmp/fleet-test"));
  await client.heartbeat(metrics,null,"Paused on this machine");
  await client.heartbeat(metrics,null,null);
  const reports = fetch.mock.calls.map(([,init]) => heartbeatSchema.parse(JSON.parse(String(init?.body))));
  expect(reports.map(report => report.admissionReason)).toEqual(["Paused on this machine",null]);
  expect(reports[0]?.currentJobId).toBeNull();
  expect(reports[0]).not.toHaveProperty("error");
});

it("keeps older heartbeat payloads valid", () => {
  expect(heartbeatSchema.parse({version:"0.1.0",metrics,currentJobId:null,labels:[]})).not.toHaveProperty("admissionReason");
});
