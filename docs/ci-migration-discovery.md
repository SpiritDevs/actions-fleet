# Reducing GitHub Actions compute costs

Discovery started 2026-09-19. The Vercel dashboard, Cloudflare-hosted relay, native execution, and initial Pathway publication scope are agreed. A minimal runner extension is permitted if needed for live logs, subject to proof and no added paid-service/licensing requirement. The consolidated [implementation plan](./implementation-plan.md) is ready for final shared-understanding confirmation. No workflows or machine configuration have been changed.

## Objective

Create a reusable service across the user's available Macs and remote Linux machines that current and future GitHub projects can target for workflow execution, avoiding routine paid hosted compute. Keep GitHub Actions as the coordinator and preserve its existing capabilities. Pathway is the first concrete example, not the scope limit.

The user accepts waiting when local capacity is unavailable and wants a manual hosted fallback. This does not authorize automatic spending. macOS and Linux support are required from the start; Windows is not a priority. Architecture-specific compatibility remains to be established per execution target.

## Fleet and dashboard requirements

The user has three Macs and wants work distributed across available machines, with the same service installable on a remote Linux machine. Only the current Mac has been inspected; the other machines' specifications and availability remain unknown. A remote Linux machine's infrastructure costs remain separate from GitHub/Blacksmith compute billing.

The user also wants a web dashboard inspired by Blacksmith, with job logs, repository identity, and enough information to monitor, audit, and triage Actions. The supplied reference shows job history, time filters, duration charts, outcome, workflow/job names, repository, branch, commit, triggering actor, and runner labels, with CPU and memory metric views.

These are requested capabilities, not a decision to reproduce every Blacksmith feature.

### Confirmed requirements from the latest round

- macOS and Linux support from the start. Windows can be deferred.
- Use GitHub's normal authorization/configuration experience to select repositories across personal accounts and multiple organizations, including accounts belonging to other people. Connecting an account is distinct from admitting outside-contributor code.
- Hosts have three user-selectable modes: Dedicated, Shared, and Paused. Dedicated supplies configured build capacity; Shared reserves resources for other work; Paused stops new admission and lets running jobs finish. Dedicated does not imply routing preference.
- Console logs must stream live inside the dashboard. Completed logs plus a GitHub link do not satisfy this requirement.
- Remote controls are part of the product. The user wants to manage jobs and machines from anywhere. Exact operations must respect GitHub's supported API semantics.
- Authenticate dashboard users with GitHub. Initially only Corey can access the service; design for explicitly allocated teammates later. Connecting another person's repositories must not implicitly give that person dashboard access.
- The dashboard is hosted on the user's Vercel account. A Cloudflare Worker/Durable Object fleet relay accepts browser and outbound host connections for logs, status, and controls. Persist history independently of an individual build machine; exact storage products remain an implementation design detail.
- Outside contributions require maintainer approval before fleet execution. Repository/account enrollment alone is insufficient approval to execute arbitrary contribution code. Jobs run natively on the enrolled machines; disposable VMs are out of the initial scope.
- Retain console logs for 30 days and job metadata/control audit history for 90 days, with configurable storage limits.
- The Cloudflare concern is pricing clarity and published availability/bandwidth/connection allocations for full-time use, not poor streaming behavior. After comparing alternatives, the user selected a hosted Worker/Durable Object relay with published usage pricing rather than per-machine Tunnels.
- Preserve Pathway's existing Actions behavior, including building nightly and production app versions and publishing the resulting artifacts to GitHub Releases. Reactivate the workflows disabled during cost reduction. This is part of the migration scope, not an optional later feature.
- Allow a minimal maintained extension of the official runner for live-log export if it adds no paid service/licensing cost. Maintenance effort and the previously discussed relay/storage usage remain real operating costs; the inspected official runner is MIT licensed.
- On relay loss, let active jobs finish, buffer their output locally within limits, and pause new work until reconnecting.
- For the initial Pathway rollout on Macs, skip Linux- and Windows-specific work instead of retaining GitHub-hosted execution for those platforms. Portable release preparation/publication steps currently labeled Ubuntu still need a macOS path so Mac app releases can complete. Generic Linux host support remains in the fleet product scope.

### Round Q11–Q15: resolved

- Q11: maintainer approval is required for outside contributions.
- Q12: Dedicated/Shared/Paused matches the intended host behavior, including drain-on-pause.
- Q13: compare clear network pricing, capacity allocations, and availability terms; Cloudflare is not ruled out.
- Q14: host the dashboard on Vercel. Its persistent backend/transport/storage placement remains to be designed.
- Q15: 30-day console logs and 90-day job/control metadata.

### Next architecture decisions

- Q16: Vercel dashboard plus a Cloudflare-hosted Worker/Durable Object fleet relay. **Agreed.** See [ADR 0004](./adr/0004-host-the-fleet-relay-on-cloudflare.md). No provider resources have been provisioned.
- Q17: native execution directly on the host. **Agreed; VM proposal rejected.** See [ADR 0005](./adr/0005-run-jobs-natively-on-fleet-hosts.md).
- Q18: a minimal official-runner extension is acceptable if required for live logs, without an added paid service/licensing cost. **Agreed, subject to a feasibility proof.** This introduces a release/update responsibility.
- Q19: active jobs finish and spool logs while new work pauses during relay loss. **Agreed.** Exact disconnect detection and admission-race semantics need implementation tests.
- Q20: no hosted-platform fallback for the initial Pathway rollout; skip Linux/Windows work on Macs. **Agreed.** Distinguish OS-specific compilation/tests from portable support steps required by Mac app publication.
- Q21: initial nightly and stable desktop downloads are Apple Silicon only. **Agreed.** Intel Mac desktop downloads are deferred.
- Q22: restore npm CLI publication too. **Agreed.** Current app publication and stable version finalization do not depend on npm; see the [migration audit](./pathway-migration.md) for platform-asset and current registry authentication constraints. CLI platform support was settled separately in Q24.
- Q23: automated Mac npm build/staging followed by operator approval in npm with 2FA. **Agreed.** A staged package must not be reported as already published.
- Q24: initial published npm CLI support is explicitly limited to Apple Silicon Macs. **Agreed.** Declare and verify the restriction in the published package; cross-platform CLI expansion is deferred.

Live log capture must be proven before committing to a runner adapter or maintained patch. This remains a technical research/prototype prerequisite rather than an assumed feature supplied by the selected transport.

### Native execution scope

The user rejected VM management in favor of straightforward native builds. The host service will launch runner jobs using installed tools, separate job workspaces, and targeted cleanup. A separate CI OS account is a possible practical boundary, not a VM substitute or a promise of strong isolation.

Start with one active job slot per physical host and distribute jobs across compatible hosts. This avoids concurrent native Pathway server shards on one machine, which would conflict with their separate-machine assumption. Shared mode can reduce concurrency, process priority, and supported tool thread counts, but cannot promise hard CPU/RAM isolation for arbitrary native workflows.

macOS and Linux remain distinct targets. Some Pathway steps use Linux-specific commands. The user chose a Mac-only initial Pathway rollout, skipping Linux/Windows-specific work rather than retaining hosted execution for those jobs. Portable release prerequisites must still be migrated to macOS. See the [feasibility plan](./feasibility-plan.md).

### Verified scheduling and visibility boundaries

- GitHub routes jobs to online, idle runners that match the requested labels/groups. This provides distribution among compatible available runners. It does not promise placement on the machine with the lowest CPU or memory use. [Self-hosted runner routing](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
- A job requesting macOS cannot spill over to a Linux-only environment. Fleet capacity must be considered per compatible execution environment.
- The Jobs REST API exposes job state, steps, timestamps, runner identity, branch, commit, and downloadable job logs. A completed-log download API is not a live streaming API. [Workflow Jobs API](https://docs.github.com/en/rest/actions/workflow-jobs)
- The official Runner Scale Set Client can support custom provisioning without Kubernetes, but is currently Public Preview. It supplies demand signals and JIT registration; host resource management, isolation, and a dashboard still require an implementation. [Official scale set client](https://github.com/actions/scaleset)

### Approved design

Keep GitHub responsible for workflow dependencies, authoritative job assignment, and check results. A service on each host supplies native execution capacity and reports machine health. The Vercel-hosted dashboard combines GitHub job metadata with host activity and streamed console logs through the Cloudflare relay. The host-mode requirements require different best-effort admission/resource policies for Dedicated and Shared use; drain-on-pause is agreed.

### GitHub integration and control findings

GitHub App authorization and installation support the required distinction between signing into the dashboard and granting access to selected repositories. User/organization authorization policies still apply; being a member of an organization does not itself grant permission to install an app with runner-management rights. [Installing GitHub Apps](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party), [authorizing GitHub Apps](https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps).

The documented Actions API supports cancellation and force-cancellation of workflow runs, rerunning a workflow or its failed jobs, and rerunning a selected job with its dependent jobs. No documented arbitrary step pause/resume or individual-job cancellation API was found. Dashboard controls must identify their actual scope and reconcile with GitHub's resulting state. Host draining and changing resource policy are separate local operations. [Workflow Runs API](https://docs.github.com/en/rest/actions/workflow-runs).

Live console collection is a required feasibility proof. GitHub's supported completed-log download does not supply a public streaming interface. Source inspection finds the runner masks console text before its normal upload and disk logging, but internal console buffers are temporary, buffered, and deleted after upload. Simply tailing diagnostic files is not sufficient evidence of a complete, prompt console stream. A collector must preserve masking, associate output with the correct job/attempt/step, and handle rotation, disconnection, replay, and bounded storage. The user accepts a minimal maintained runner extension if needed without a paid-service or license dependency; its post-masking export is the proposed proof target.

Source evidence: [masking boundary in ExecutionContext](https://github.com/actions/runner/blob/80bb1fb827fa44d489263061e71ef4adba7ad8cd/src/Runner.Worker/ExecutionContext.cs#L1099), [buffered console logging](https://github.com/actions/runner/blob/80bb1fb827fa44d489263061e71ef4adba7ad8cd/src/Runner.Common/Logging.cs), [start/end notifications](https://github.com/actions/runner/blob/80bb1fb827fa44d489263061e71ef4adba7ad8cd/src/Runner.Common/JobNotification.cs). The notification socket is not a console stream and carries sensitive job context; it must not be exposed directly to dashboard clients.

The Vercel/network alternatives and selected Cloudflare relay are recorded in [connection-options.md](./connection-options.md). VPS and per-machine Tunnel designs are retained as considered alternatives.

### Pathway Cloudflare investigation

The inspected source at `6590b4207` uses Cloudflare Tunnel for reachability and a relay for discovery/authentication. Normal application traffic travels between clients and the environment over the managed endpoint. See [relay README](https://github.com/SpiritDevs/pathway/blob/6590b42077188c0e5e2141fb4b0d584f2413737b/infra/relay/README.md) and [managed endpoint runtime](https://github.com/SpiritDevs/pathway/blob/6590b42077188c0e5e2141fb4b0d584f2413737b/apps/server/src/cloud/ManagedEndpointRuntime.ts).

The closest log-like feature found is terminal attachment: subscribe, obtain a retained history snapshot, deliver buffered events, then continue live. The server retains 5,000 lines and the client keeps a bounded buffer. Reconnection reattaches and receives a retained snapshot; the terminal subscription has no durable log-offset cursor. This is useful terminal scrollback, not a complete CI console archive. See [terminal manager](https://github.com/SpiritDevs/pathway/blob/6590b42077188c0e5e2141fb4b0d584f2413737b/apps/server/src/terminal/Manager.ts) and [terminal contracts](https://github.com/SpiritDevs/pathway/blob/6590b42077188c0e5e2141fb4b0d584f2413737b/packages/contracts/src/terminal.ts).

No existing GitHub Actions live-log dashboard or Cloudflare Durable Object log broker was found in that inspection. The user subsequently clarified that the concern is Cloudflare Tunnel's commercial/usage clarity, not the terminal streaming implementation. A new fleet log design should distinguish remote reachability from durable collection, storage, and browser replay.

## Verified baseline

- Pathway is the public repository `SpiritDevs/pathway`; its local checkout is `~/Github/pathway`.
- A refreshed GitHub check found all 10 workflow records in the `active` state but repository-wide Actions permissions report `enabled: false`. Several YAML triggers are also removed. Re-enabling requires both workflow restoration and repository settings, in that order after routing is ready; merely enabling the repository could resume existing Blacksmith schedules/deployments.
- The Mac has an Apple M2 Max, 12 CPU cores, 32 GiB RAM, macOS 26.5.1, hardware virtualization support, and approximately 228 GiB free disk space.
- The Mac is on AC power, system sleep is disabled, and automatic restart is enabled. Unattended recovery after reboot and sustained build capacity have not been verified.
- No existing runner service or common VM/container runtime was detected in the targeted machine audit.
- This `github-actions` directory was initially empty and is not currently a Git repository.
- The local Pathway checkout is branch `feat/background-service-controls`, commit `6de1f0487` (September 12). Live `main` is `6590b4207` (September 17). The distinction matters for a migration pilot.
- In the local checkout, `.github/workflows/ci.yml` runs on pull requests and expands to seven jobs: Check, Test, three Test Server shards, Rust, and Release Smoke. Its labels select Blacksmith Ubuntu runners with 8 vCPUs, except Rust with 4 vCPUs. The server setup uses `apt-get`.
- The local `.github/workflows/release.yml` builds desktop artifacts for macOS arm64, macOS x64, Linux x64, and Windows x64. Its main build matrix uses Blacksmith 12-vCPU macOS and 32-vCPU Linux/Windows runners.
- On live `main`, CI and several auxiliary workflows are manual-only. Release checks run every three hours and can also be triggered manually, with nightly metadata and a macOS ARM64-only build matrix. Active Blacksmith jobs are Preflight (8-vCPU Ubuntu), Build (12-vCPU macOS), and Deploy web (8-vCPU Ubuntu). Several coordination/publication jobs already use `ubuntu-latest`; other Blacksmith labels exist behind currently unreachable stable-release conditions.
- The live dictation workflow still accepts pull requests for selected native paths, using hosted macOS and Windows runners. No Blacksmith-specific action/cache integration or Docker container/service declarations were found in the workflow audit; Vite+ setup enables its own dependency caching.
- The live relay deployment still uses Blacksmith Ubuntu for path-filtered main-branch pushes. Native Apple client builds are manual-only, on hosted macOS, and require ARM64 and Xcode.
- The current Mac release job includes signing/notarization credentials and a production deployment credential. It is not simply an unsigned compilation task.
- The web deployment invokes Vercel without `--prebuilt`; changing the Actions runner alone would not move Vercel's remote build work onto this Mac.
- Three sampled successful September 15 releases spent approximately six minutes in the Mac build, under one minute in preflight, and under three minutes in web deployment. Two historical CI runs used approximately 14 aggregate runner-minutes each while finishing in approximately 3–4 minutes through parallelism. These are execution-time samples, not billing measurements.
- A native macOS ARM runner would therefore not preserve the existing execution environments just by replacing runner labels. Performance on the Mac and on smaller hosted runners remains unmeasured.

Audited remote sources: [CI](https://github.com/SpiritDevs/pathway/blob/6590b42077188c0e5e2141fb4b0d584f2413737b/.github/workflows/ci.yml), [Release](https://github.com/SpiritDevs/pathway/blob/6590b42077188c0e5e2141fb4b0d584f2413737b/.github/workflows/release.yml), [sample release run](https://github.com/SpiritDevs/pathway/actions/runs/35024221104), [sample historical CI run](https://github.com/SpiritDevs/pathway/actions/runs/34272211439).

## External constraints

- Standard GitHub-hosted runner compute is free for public repositories, including Linux, Windows, and macOS. Larger runners are billed. Artifact and cache storage have separate allowances and billing rules. Private repositories have a different hosted-compute allowance. [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- Current GitHub documentation states that self-hosted runner usage is free; maintaining the hardware and its software is the operator's responsibility. [Self-hosted runners](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners)
- GitHub Actions Docker container actions and service containers require a Linux runner with Docker installed. Jobs targeting an unavailable self-hosted runner queue, and fail after 24 hours without a matching runner. [Runner requirements and routing](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
- Public pull-request code must be considered when deciding which work can execute on this Mac. Persistent self-hosted environments require a deliberate trust boundary; runner registration alone does not isolate jobs from the host or each other. [GitHub secure-use reference](https://docs.github.com/en/actions/reference/security/secure-use)

## Candidate approaches, not decisions

1. Move Pathway to standard GitHub-hosted runners and measure performance. This could remove Blacksmith compute charges without operating a local runner, but it would not fulfill the user's broader objective of a reusable fleet service. It remains relevant as a comparison and possible explicit fallback.
2. Use a hybrid: standard hosted runners for outside contributions and platform-specific work, with selected trusted work executing on the Mac. Benchmark before committing to the split.
3. Provide a reusable fleet service with host-side runner management and a central dashboard. Mac and Linux hosts contribute compatible capacity. This requires capacity, architecture, isolation, cleanup, and recovery decisions; Windows x64 builds remain a separate compatibility problem.

## Decision tree

- Cost objective: reusable execution for current and future projects, avoiding routine paid hosted compute. **Agreed.**
- Fleet: three Macs, plus the ability to enroll remote Linux machines and distribute work. **Requested.**
- Visibility: a shared web dashboard with live job logs, repository context, and monitoring/triage information. **Agreed.**
- Controls: remote management of jobs and machines, with supported API semantics to be specified. **Agreed.**
- Identity: GitHub login; owner-only access initially; future explicitly admitted teammates. **Agreed.**
- Connections: selected repositories across personal accounts and multiple organizations, including other people's accounts. **Agreed.**
- Platforms: macOS and Linux from the start; Windows deferred. **Agreed.**
- Host policy: Dedicated, Shared, and Paused with drain-on-pause. **Agreed.**
- Outside contributions: require maintainer approval. **Agreed.**
- Dashboard hosting: Vercel, with a Cloudflare Worker/Durable Object fleet relay. **Agreed.**
- Retention: 30-day logs and 90-day metadata/control audit. **Agreed.**
- Workflow parity: preserve GitHub Actions workflow and existing capabilities. **Agreed.**
- Availability: allow waiting and provide a manual hosted fallback. **Agreed.**
- Native execution, conditional runner extension, relay-outage behavior, and Mac-only Pathway rollout are agreed. Apple Silicon desktop downloads and restoration of npm CLI publication are also agreed.
- Publication decisions are settled: Apple Silicon desktop and npm CLI, automated GitHub Releases, and npm staging followed by operator approval. Runner, relay, and migration validation are documented in the [feasibility plan](./feasibility-plan.md).
- Before implementation: confirm the [consolidated design and pilot](./implementation-plan.md). Routine toolchain, cleanup, cache, and service-restart details are implementation choices to document and verify. Unproven live-log capture and native execution behavior remain technical validation work, not promised completed capabilities.

Record agreed domain vocabulary when it emerges. Accepted architectural decisions are recorded in `docs/adr/`; remaining execution options are proposals.
