import { appJwt } from "./crypto.ts";
import { HttpError } from "./types.ts";
import type { Env } from "./types.ts";

export interface GitHubRun {
  id: number; run_attempt: number; head_sha: string; head_branch: string;
  event: string; status: string; conclusion: string | null; name: string; html_url: string;
  actor: { login: string; id: number }; triggering_actor?: { login: string; id: number };
  pull_requests: { number: number }[]; repository: { id: number; full_name: string; default_branch?: string };
}
export interface PullRequestRevision {
  number: number; user: { login: string };
  head: { sha: string; ref: string };
  base: { sha: string; repo: { id: number } };
}
export class GitHub {
  private tokens = new Map<number, { token: string; expires: number }>();
  constructor(private env: Env) {}
  async request<T>(path: string, token: string, method = "GET", data?: unknown): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "actions-fleet", "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    if (!response.ok) {
      // Do not echo GitHub response bodies, OAuth credentials or installation tokens.
      throw new HttpError(response.status === 404 ? 404 : 502, `GitHub ${method} ${path.split("?")[0]} returned ${response.status}`);
    }
    if (response.status === 204 || response.headers.get("Content-Length") === "0") return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  async app<T>(path: string): Promise<T> { return this.request<T>(path, await appJwt(this.env.GITHUB_APP_ID, this.env.GITHUB_APP_PRIVATE_KEY)); }
  async token(installation: number): Promise<string> {
    const previous = this.tokens.get(installation);
    if (previous && previous.expires > Date.now() + 60000) return previous.token;
    const next = await this.request<{ token: string; expires_at: string }>(`/app/installations/${installation}/access_tokens`, await appJwt(this.env.GITHUB_APP_ID, this.env.GITHUB_APP_PRIVATE_KEY), "POST", {});
    this.tokens.set(installation, { token: next.token, expires: Date.parse(next.expires_at) });
    return next.token;
  }
  async installation<T>(installation: number, path: string, method = "GET", data?: unknown): Promise<T> {
    return this.request<T>(path, await this.token(installation), method, data);
  }
  async run(installation: number, repo: string, run: number): Promise<GitHubRun> {
    return this.installation<GitHubRun>(installation, `/repos/${repo}/actions/runs/${run}`);
  }
  async writer(installation: number, repo: string, login: string): Promise<boolean> {
    try {
      const result = await this.installation<{ permission: string }>(installation, `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
      return ["admin", "maintain", "write"].includes(result.permission);
    } catch { return false; }
  }
  async pullRequests(installation: number, repo: string, run: GitHubRun): Promise<PullRequestRevision[]> {
    if (!["pull_request", "pull_request_target"].includes(run.event)) return [];
    // GitHub often leaves workflow_run.pull_requests empty, including real
    // Pathway PR/PR-target runs. Commit association supplies the missing link.
    if (run.pull_requests.length > 20) return [];
    const candidates = run.pull_requests.length
      ? await Promise.all(run.pull_requests.map(pr => this.installation<PullRequestRevision>(installation, `/repos/${repo}/pulls/${pr.number}`)))
      : await this.installation<PullRequestRevision[]>(installation, `/repos/${repo}/commits/${run.head_sha}/pulls?per_page=100`);
    if (!Array.isArray(candidates) || candidates.length >= 100) return [];
    return candidates.filter(pr => pr.head.sha === run.head_sha && pr.head.ref === run.head_branch && pr.base.repo.id === run.repository.id);
  }
  async revision(installation: number, repo: string, run: GitHubRun): Promise<string | null> {
    if (!["pull_request", "pull_request_target"].includes(run.event)) return `run:${run.head_sha}`;
    const requests = await this.pullRequests(installation, repo, run);
    if (!requests.length) return null;
    return requests.map(pr => `${pr.number}:${pr.head.sha}`).sort().join(",");
  }
  async executionRevision(installation: number, repo: string, run: GitHubRun, executionSha: string): Promise<boolean> {
    if (!["pull_request", "pull_request_target"].includes(run.event)) return executionSha === run.head_sha;
    const requests = await this.pullRequests(installation, repo, run);
    if (!requests.length) return false;
    if (run.event === "pull_request") {
      if (executionSha === run.head_sha) return true;
      const commit = await this.installation<{ parents: { sha: string }[] }>(installation, `/repos/${repo}/git/commits/${executionSha}`);
      return commit.parents.length === 2 && commit.parents[1]?.sha === run.head_sha;
    }
    // Since 2025-12-08 PR-target executes the repository's default branch,
    // including PRs targeting a different branch. REST run.head_sha still
    // identifies the PR tip; the association above keeps approval pinned to it.
    // Workflow-run repository payloads can omit default_branch, so resolve it
    // from the repository API rather than using the PR base or a guessed name.
    const repository = await this.installation<{ id: number; full_name: string; default_branch?: string }>(installation, `/repos/${repo}`);
    if (repository.id !== run.repository.id || repository.full_name.toLowerCase() !== repo.toLowerCase() || !repository.default_branch?.trim()) return false;
    const branch = await this.installation<{ commit?: { sha?: string } }>(installation, `/repos/${repo}/branches/${encodeURIComponent(repository.default_branch)}`);
    const defaultSha = branch.commit?.sha;
    if (!defaultSha || !/^[0-9a-f]{40}$/i.test(defaultSha) || !/^[0-9a-f]{40}$/i.test(executionSha)) return false;
    if (executionSha === defaultSha) return true;
    // Queued jobs and reruns may use an older default-branch commit. Only an
    // ancestor is acceptable; an unmerged PR/base branch must not become an
    // alternate source of trusted execution code.
    const comparison = await this.installation<{ status: string }>(installation, `/repos/${repo}/compare/${executionSha}...${defaultSha}`);
    return ["ahead", "identical"].includes(comparison.status);
  }
  async trusted(installation: number, repo: string, run: GitHubRun): Promise<boolean> {
    if (run.repository.full_name.toLowerCase() !== repo.toLowerCase()) return false;
    if (["pull_request", "pull_request_target"].includes(run.event)) {
      // The original PR author remains the trust boundary after a maintainer rerun.
      const requests = await this.pullRequests(installation, repo, run);
      if (!requests.length) return false;
      for (const detail of requests) {
        if (!await this.writer(installation, repo, detail.user.login)) return false;
      }
      return this.writer(installation, repo, run.actor.login);
    }
    // A verified repository writer can intentionally trigger issue comments,
    // workflow_run, repository_dispatch, and other non-PR events as well. Event
    // names do not grant trust: unknown/outside actors still need approval.
    if (run.actor.login === "github-actions[bot]" && run.actor.id === 41898282 && run.head_branch === run.repository.default_branch && ["schedule", "push"].includes(run.event)) return true;
    return this.writer(installation, repo, run.actor.login);
  }
}

export function compatible(labels: string[], platform: string, architecture: string, hostLabels: string[]): boolean {
  const family = platform === "darwin" ? "macos" : "linux";
  const fleetLabel = `fleet-${family}-${architecture}`;
  if (!labels.some(label => label.toLowerCase() === fleetLabel)) return false;
  const available = new Set(["self-hosted", family, architecture, fleetLabel, ...hostLabels].map(label => label.toLowerCase()));
  return labels.every(label => available.has(label.toLowerCase()));
}
