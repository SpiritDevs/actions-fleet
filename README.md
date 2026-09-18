# Actions Fleet

Run GitHub Actions on your own Macs and Linux machines. Keep GitHub workflows, checks, artifacts, and releases, with a shared dashboard for live logs and remote controls.

The service is being implemented. Do not switch production workflows until the native runner, approval gate, and live-log pilot pass on your hosts.

## Components

- `apps/agent`: native host service, one-job admission, durable log spool, and Mac/Linux service installation.
- `apps/relay`: Cloudflare Worker and Durable Object for GitHub integration, host enrollment, job state, control audit, and resumable logs.
- `apps/dashboard`: React dashboard hosted on Vercel.
- `apps/menubar`: lightweight native Mac menu bar status and controls.
- `patches/runner`: maintained, opt-in console export after the official runner's secret masking.

Dedicated hosts provide configured capacity; Shared hosts reserve room for other work; Paused hosts finish current work and accept no new jobs. GitHub distributes jobs among compatible available runners. Mac jobs require Mac hosts, and Linux/container jobs require compatible Linux hosts.

Use Node 24 LTS and npm. Development/build instructions will be completed alongside integration. The fleet pilot is manually triggered and targets self-hosted labels only; creating this repository does not start paid hosted builds.

Native job execution uses the host's installed tools and permissions. Enroll repositories you trust, require approval for outside contributions, and keep job workspaces separate from your everyday projects. Workspace cleanup is not VM isolation.

GitHub remains the workflow authority. The Vercel dashboard and Cloudflare relay have their own hosting/storage usage; this project removes routine hosted build-runner compute rather than promising zero operating cost.
