# Actions Fleet

Run GitHub Actions on your own Macs and Linux machines. Keep GitHub workflows, checks, artifacts, and releases, with a shared dashboard for live logs and remote controls.

The dashboard, relay, native host service, and Mac menu bar app are implemented. The first Mac has passed real GitHub build, live-log, reconnect, cancellation, artifact, and denied-admission pilots. See the [verification record](docs/verification.md) for evidence and remaining platform coverage.

## Components

- `apps/agent`: native host service, one-job admission, durable log spool, and Mac/Linux service installation.
- `apps/relay`: Cloudflare Worker and Durable Object for GitHub integration, host enrollment, job state, control audit, and resumable logs.
- `apps/dashboard`: React dashboard hosted on Vercel.
- `apps/menubar`: lightweight native Mac menu bar status and controls.
- `patches/runner`: maintained, opt-in console export after the official runner's secret masking.

Dedicated hosts provide configured capacity; Shared hosts reserve room for other work; Paused hosts finish current work and accept no new jobs. GitHub distributes jobs among compatible available runners. Mac jobs require Mac hosts, and Linux/container jobs require compatible Linux hosts.

Use Node 24 LTS and npm:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Follow the [deployment guide](docs/deployment.md) to create the GitHub App, deploy
the relay and dashboard, and enroll your first host. Read the
[host service guide](apps/agent/README.md) for native execution, startup, Shared
mode, and recovery. The [Mac menu app](apps/menubar/README.md) provides local
status and pause controls. The fleet pilot is manually triggered and targets
self-hosted labels only.

New repositories select compatible labels, for example:

```yaml
runs-on: [self-hosted, fleet-macos-arm64]
```

Linux hosts advertise `fleet-linux-x64` or `fleet-linux-arm64`; Intel Macs use
`fleet-macos-x64`. Multiple enrolled hosts with matching labels supply a shared
pool. The service initially admits one job per physical host. GitHub handles
assignment; jobs wait if compatible capacity is unavailable.

Native job execution uses the host's installed tools and permissions. Enroll repositories you trust, require approval for outside contributions, and keep job workspaces separate from your everyday projects. Workspace cleanup is not VM isolation.

GitHub remains the workflow authority. The Vercel dashboard and Cloudflare relay have their own hosting/storage usage; this project removes routine hosted build-runner compute rather than promising zero operating cost. Logs retain up to 30 days within configurable byte limits; metadata and control audit retain 90 days. Full GitHub job logs and artifacts continue using GitHub's own retention settings.
