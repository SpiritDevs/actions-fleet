import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appJwt, hash, randomToken, verifySignature } from "../src/crypto.ts";
import { compatible, GitHub } from "../src/github.ts";
import type { GitHubRun } from "../src/github.ts";
import type { Env } from "../src/types.ts";
import { preservePatchedRunner } from "../src/jit.ts";

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");
afterEach(() => vi.restoreAllMocks());

describe("credential primitives", () => {
  it("verifies exact raw webhook bytes and rejects malformed signatures", async () => {
    const bytes = new TextEncoder().encode('{"x": 1}');
    const signature = `sha256=${createHmac("sha256", "test-secret").update(bytes).digest("hex")}`;
    expect(await verifySignature("test-secret", bytes.buffer as ArrayBuffer, signature)).toBe(true);
    expect(await verifySignature("wrong", bytes.buffer as ArrayBuffer, signature)).toBe(false);
    expect(await verifySignature("test-secret", new TextEncoder().encode('{"x":1}').buffer as ArrayBuffer, signature)).toBe(false);
    expect(await verifySignature("test-secret", bytes.buffer as ArrayBuffer, "sha256=nope")).toBe(false);
  });
  it("creates opaque tokens and only stores their one-way lookup values", async () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
    expect(await hash(token)).not.toBe(token);
    expect(await hash(token)).toBe(await hash(token));
  });
  it.each(["pkcs1", "pkcs8"] as const)("signs valid bounded JWTs using %s PEM", async type => {
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = key.privateKey.export({ format: "pem", type }).toString();
    const jwt = await appJwt("123", pem.replace(/\n/g, "\\n"));
    const [header, payload, signature] = jwt.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(claims.iss).toBe("123");
    expect(claims.exp - claims.iat).toBe(600);
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), key.publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  });
});

describe("patched ephemeral JIT settings", () => {
  it("preserves credential file bytes while disabling replacement of the exporter", () => {
    const files = { ".runner": encode({ agentName: "fleet-test", ephemeral: true, DisableUpdate: false, workFolder: "_work" }), ".credentials": "cHJlc2VydmVkLWNyZWRlbnRpYWxz" };
    const result = JSON.parse(Buffer.from(preservePatchedRunner(encode(files), "fleet-test"), "base64").toString());
    expect(result[".credentials"]).toBe(files[".credentials"]);
    expect(JSON.parse(Buffer.from(result[".runner"], "base64").toString())).toEqual({ agentName: "fleet-test", ephemeral: true, disableUpdate: true, workFolder: "_work" });
  });
  it.each(["True", "TRUE", "true"])("normalizes the real PascalCase REST JIT shape with Ephemeral=%s for the unchanged agent", value => {
    const original = { AgentId: "42", AgentName: "fleet-test", DisableUpdate: "False", Ephemeral: value, PoolId: "1", PoolName: "Default", ServerUrl: "https://example.invalid/runner", WorkFolder: "_work", GitHubUrl: "https://github.com/example/repo", ServerUrlV2: "https://example.invalid/broker", UseV2Flow: "True" };
    const files = { ".runner": encode(original), ".credentials": encode({ scheme: "test-only", token: "not-a-real-credential" }), ".credentials_rsaparams": encode({ test: "unchanged" }) };
    const encoded = preservePatchedRunner(encode(files), "fleet-test");
    const result = JSON.parse(Buffer.from(encoded, "base64").toString());
    const settings = JSON.parse(Buffer.from(result[".runner"], "base64").toString());
    const { Ephemeral: _ephemeral, DisableUpdate: _disableUpdate, ...remaining } = original;
    expect(settings).toEqual({ ...remaining, ephemeral: true, disableUpdate: true });
    expect(result[".credentials"]).toBe(files[".credentials"]);
    expect(result[".credentials_rsaparams"]).toBe(files[".credentials_rsaparams"]);
  });
  it.each([false, "False", "false", "True ", 1, null])("rejects non-true string/boolean ephemeral settings (%s)", value => {
    expect(() => preservePatchedRunner(encode({ ".runner": encode({ AgentName: "fleet-test", Ephemeral: value }) }), "fleet-test")).toThrow("incompatible");
  });
  it("removes duplicate boolean spellings and rejects conflicting ephemeral/name settings", () => {
    const encoded = preservePatchedRunner(encode({ ".runner": encode({ AgentName: "fleet-test", Ephemeral: "True", EPHEMERAL: true, DisableUpdate: "False", DISABLEUPDATE: false }) }), "fleet-test");
    const settings = JSON.parse(Buffer.from(JSON.parse(Buffer.from(encoded, "base64").toString())[".runner"], "base64").toString());
    expect(settings).toEqual({ AgentName: "fleet-test", ephemeral: true, disableUpdate: true });
    expect(() => preservePatchedRunner(encode({ ".runner": encode({ AgentName: "fleet-test", Ephemeral: "True", ephemeral: false }) }), "fleet-test")).toThrow("incompatible");
    expect(() => preservePatchedRunner(encode({ ".runner": encode({ AgentName: "fleet-test", agentName: "different", Ephemeral: "True" }) }), "fleet-test")).toThrow("incompatible");
  });
  it.each(["not-base64!", encode({}), encode({ ".runner": "bad" }), "a".repeat(262145), encode({ ".runner": encode({ agentName: "wrong", ephemeral: true }) }), encode({ ".runner": encode({ agentName: "fleet-test", ephemeral: false }) }), encode({ ".runner": encode({ agentName: "fleet-test", ephemeral: true }), "../escape": "eA==" })])("fails closed for incompatible JIT input", value => {
    expect(() => preservePatchedRunner(value, "fleet-test")).toThrow("incompatible");
  });
});

describe("routing and original-author trust", () => {
  const run: GitHubRun = { id: 1, run_attempt: 1, head_sha: "a".repeat(40), head_branch: "main", event: "push", status: "queued", conclusion: null, name: "test", html_url: "https://github.com/owner/repo/actions/runs/1", actor: { id: 1, login: "maintainer" }, triggering_actor: { id: 1, login: "maintainer" }, pull_requests: [], repository: { id: 2, full_name: "owner/repo", default_branch: "main" } };
  it("requires explicit compatible fleet OS/architecture and every capability", () => {
    expect(compatible(["self-hosted", "fleet-macos-arm64", "xcode"], "darwin", "arm64", ["xcode"])).toBe(true);
    expect(compatible(["fleet-linux-x64"], "darwin", "arm64", ["fleet-linux-x64"])).toBe(false);
    expect(compatible(["self-hosted", "macOS"], "darwin", "arm64", [])).toBe(false);
    expect(compatible(["fleet-macos-arm64", "xcode"], "darwin", "arm64", [])).toBe(false);
  });
  it("does not trust an outside PR author merely because a maintainer reran it", async () => {
    const github = new GitHub({} as Env);
    vi.spyOn(github, "installation").mockResolvedValue({ number: 3, user: { login: "outside" }, head: { sha: run.head_sha, ref: "main" }, base: { sha: "b".repeat(40), repo: { id: 2 } } });
    vi.spyOn(github, "writer").mockImplementation(async (_installation, _repo, login) => login === "maintainer");
    expect(await github.trusted(1, "owner/repo", { ...run, event: "pull_request", pull_requests: [{ number: 3 }] })).toBe(false);
    expect(await github.trusted(1, "owner/repo", { ...run, event: "pull_request_target", pull_requests: [] })).toBe(false);
  });
  it("validates merge and target execution SHAs while pinning approval to the associated PR head", async () => {
    const github = new GitHub({} as Env);
    const pr = { number: 3, user: { login: "maintainer" }, head: { sha: run.head_sha, ref: "main" }, base: { sha: "b".repeat(40), repo: { id: 2 } } };
    const installation = vi.spyOn(github, "installation").mockImplementation(async (_id, path) => {
      if (path.includes("/pulls?")) return [pr];
      if (path.includes("/git/commits/")) return { parents: [{ sha: pr.base.sha }, { sha: pr.head.sha }] };
      if (path.includes("/compare/")) return { status: "ahead" };
      throw new Error("Unexpected API");
    });
    const pull = { ...run, event: "pull_request" };
    expect(await github.revision(1, "owner/repo", pull)).toBe(`3:${run.head_sha}`);
    expect(await github.executionRevision(1, "owner/repo", pull, "c".repeat(40))).toBe(true);
    expect(await github.executionRevision(1, "owner/repo", { ...pull, event: "pull_request_target" }, pr.base.sha)).toBe(true);
    expect(await github.executionRevision(1, "owner/repo", { ...pull, event: "pull_request_target" }, "d".repeat(40))).toBe(true);
    pr.head.sha = "e".repeat(40);
    expect(await github.revision(1, "owner/repo", pull)).toBeNull();
    expect(await github.executionRevision(1, "owner/repo", { ...pull, event: "pull_request_target" }, pr.base.sha)).toBe(false);
    installation.mockResolvedValue([{ ...pr, head: { sha: run.head_sha, ref: "main" }, base: { sha: pr.base.sha, repo: { id: 999 } } }]);
    expect(await github.revision(1, "owner/repo", pull)).toBeNull();
  });
  it("auto-admits verified writers and only recognizes the real Actions bot on default branch", async () => {
    const github = new GitHub({} as Env);
    vi.spyOn(github, "writer").mockImplementation(async (_installation, _repo, login) => login === "maintainer");
    expect(await github.trusted(1, "owner/repo", run)).toBe(true);
    const bot = { ...run, event: "schedule", actor: { login: "github-actions[bot]", id: 41898282 } };
    expect(await github.trusted(1, "owner/repo", bot)).toBe(true);
    expect(await github.trusted(1, "owner/repo", { ...bot, head_branch: "untrusted" })).toBe(false);
    expect(await github.trusted(1, "owner/repo", { ...bot, actor: { login: bot.actor.login, id: 4 } })).toBe(false);
    expect(await github.trusted(1, "owner/repo", { ...bot, event: "issue_comment" })).toBe(false);
    expect(await github.trusted(1, "another/repo", run)).toBe(false);
  });
  it.each(["issue_comment", "workflow_run", "repository_dispatch"])("trusts a verified writer for %s while keeping outside actors behind approval", async event => {
    const github = new GitHub({} as Env);
    vi.spyOn(github, "writer").mockImplementation(async (_installation, _repo, login) => login === "maintainer");
    expect(await github.trusted(1, "owner/repo", { ...run, event })).toBe(true);
    expect(await github.trusted(1, "owner/repo", { ...run, event, actor: { id: 99, login: "outside" } })).toBe(false);
    expect(await github.trusted(1, "another/repo", { ...run, event })).toBe(false);
  });
});
