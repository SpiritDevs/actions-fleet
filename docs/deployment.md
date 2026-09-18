# Deploy and enroll

The current deployment uses [actions.spiritdevs.com](https://actions.spiritdevs.com)
for the Vercel dashboard and [api.actions.spiritdevs.com](https://api.actions.spiritdevs.com)
for the Cloudflare relay. The examples below use placeholders for another deployment.
See the [verification record](verification.md) for the two-Mac validation and
the remaining Linux coverage limit.

Use Node 24 LTS. Install dependencies with `npm ci`, then run `npm run typecheck`,
`npm test`, and `npm run build`. Tests are scoped to this repository's application,
protocol, and script directories; ignored worktrees and runner checkouts are excluded.

## GitHub App

Set `DASHBOARD_ORIGIN`, `RELAY_PUBLIC_URL`, and `GITHUB_APP_ORGANIZATION` for your
deployment, then run `node scripts/setup-github-app.mjs`. Open the local URL and
submit the manifest. It supplies the repository permissions, webhook events,
callback, and installation URL. Install the App only on the repositories you
want to connect. The generated keys are stored in ignored `.fleet/github-app.json`
with owner-only permissions. Keep a secure backup using your usual secret storage.

The normal GitHub form asks for confirmation; there is no need to manually enter
every permission. Installation lifecycle events are delivered automatically and
must not be included in the manifest's requested event list.

## Cloudflare relay

Log in with the repository-pinned Wrangler CLI. Choose an account that owns the
relay hostname's Cloudflare zone. Generate an ignored deployment configuration:

```sh
export CLOUDFLARE_ACCOUNT_ID=YOUR_ACCOUNT_ID
export OWNER_GITHUB_ID=YOUR_NUMERIC_GITHUB_USER_ID
export DASHBOARD_ORIGIN=https://actions.example.com
export RELAY_PUBLIC_URL=https://api.actions.example.com
node scripts/prepare-relay.mjs
npx wrangler deploy --config .fleet/wrangler.json
node scripts/upload-relay-secrets.mjs
```

The script uploads App secrets through Wrangler's standard input, without putting
their values in command arguments or printed output. Custom domain deployment
creates the relay DNS record and certificate. Certificate issuance can take time;
verify HTTPS before attempting host enrollment. Endpoints fail closed until App
and operator configuration is complete. Durable Object SQLite stores the history.
Default log limits are 256 MiB for the fleet and 32 MiB per job, alongside the
30-day retention limit; older lines can be evicted when a byte limit is reached.

## Vercel dashboard

Create and link a Vercel project for this checkout. Set the dashboard hostname on
that project and add the DNS/verification records Vercel supplies at your DNS
provider. Keep the dashboard and App callback origins identical.

Build on your machine and upload the static result:

```sh
npm run build --workspace @actions-fleet/dashboard
node scripts/prepare-dashboard.mjs
npx vercel deploy --prebuilt --prod
```

`prepare-dashboard.mjs` reads `RELAY_PUBLIC_URL` and prepares Vercel Build Output
API files. API and authentication requests use same-origin rewrites to the relay.
Live sockets connect directly to the relay using short-lived single-use tickets.
The checked-in `vercel.json` is an example for the SpiritDevs deployment; update
its destinations if using Vercel's remote build integration. The local prebuilt
path avoids a Vercel source build. Hosting and network usage remain subject to
your provider plan.

## Hosts

Build the pinned runner for each target OS/architecture with
`node scripts/build-runner.mjs`, then build the host agent. The first runner build
downloads the upstream source and .NET toolchain. Each host needs its projects'
normal build tools, signing tools, and available disk space.

Hosts with the same OS/architecture can reuse a verified unregistered template;
do not copy an active runner's credentials or workspace. Install the agent,
Node LTS runtime, and template in a stable location outside a disposable source
checkout, then generate service files using those installed paths. The two-Mac
deployment reused the same patched ARM64 template and bundled Node 24 runtime.
Advertise `xcode` only after full Xcode, first-launch setup, and required SDK
discovery pass on that host.

Sign in to the dashboard with the configured GitHub owner, sync repository
connections, and enable a pilot repository. Create a one-use enrollment token and
follow [host setup](../apps/agent/README.md). Hosts start Paused. Set Dedicated or
Shared only after checking installed toolchains and runner labels. One physical
host supplies one active slot. Additional compatible machines increase capacity;
GitHub assigns the jobs.

Shared mode defaults to CPU usage at or below 50% and at least 4 GiB available
memory. The optional available-memory metric includes reclaimable cache; missing
or invalid readings fall back to free memory. Shared jobs run with lower process
priority and supported tool concurrency limits, with no hard CPU/memory cap.
Mac LaunchAgents use `Interactive` scheduling so launchd does not impose separate
background throttling on every job. For a service update, pause admission, wait
for an idle status, unload the tracked service, replace installed files, and
bootstrap it again. Wait for the prior unload to complete before retrying a
transient bootstrap failure; do not stop unrelated processes.

On a Mac, build `sh apps/menubar/build.sh` and open the generated Actions Fleet
app. It reads the host's nonsecret status and offers local pause/resume. The host
service is separate and continues running when the menu app quits.

## Verification before migration

Run the manual pilot on your fleet. Verify that the job appears in GitHub and the
dashboard, live output arrives during the job, secrets remain masked, artifacts
are downloadable, cancellation works, and the host becomes available afterward.
Exercise denied admission with a workflow containing `if: always()` steps; normal
GitHub step failure alone is insufficient as an execution boundary. Restore a
disconnected relay and verify ordered replay without rerunning the job.

Only then migrate production workflows. Keep unmatched platform jobs explicit,
document skipped coverage, and never silently choose paid hosted capacity.

## Operator automation

`scripts/operator-client.mjs` uses an existing `gh auth login` identity to obtain
a one-hour fleet session. The relay independently verifies the numeric GitHub
user ID against its configured owner. This follows the same operator permissions
as the dashboard and records an audit event. It cannot grant access to another
GitHub user. Normal browser login remains available for remote operation.
