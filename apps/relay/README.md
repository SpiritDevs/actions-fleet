# Fleet relay

Cloudflare Worker front end with one SQLite Durable Object for the initial owner-managed fleet. Durable state includes GitHub installations, enabled repositories, hashed sessions/host tokens, one-use enrollment and socket tickets, jobs, revision-specific approvals, host capacity leases, ordered masked console records, and audit events. It uses real GitHub App/OAuth APIs; missing credentials produce a setup error. No development identity bypass exists.

## Configuration

From the repository root:

```sh
npm run dev:relay
npm run typecheck --workspace @actions-fleet/relay
npx vitest run apps/relay/test
npm run build --workspace @actions-fleet/relay
```

`build` is a Wrangler **dry run**, not a deployment. Endpoint tests bundle that same Worker and execute it with Miniflare's SQLite Durable Objects, intercepting only outbound GitHub requests. No test installs a real runner or publishes a release.

Configure the Cloudflare account through Wrangler's normal account configuration. `wrangler.jsonc` contains no account identifier or secret. Configure `DASHBOARD_ORIGIN` and `RELAY_PUBLIC_URL` for the actual deployments; the initial proposed domains are `https://actions.spiritdevs.com` and `https://api.actions.spiritdevs.com`. Set `OWNER_GITHUB_ID` to the operator's numeric GitHub ID, initially `2592956`.

Use a GitHub App with repository **Administration: write**, **Actions: write**, **Contents: read**, **Pull requests: read**, and GitHub's mandatory **Metadata: read**. Administration is needed for repository runner registration and outside-contributor approval policy configuration. No organization runner permission is needed: registrations are scoped to each installed repository. Normal GitHub installation approval and selected-repository access apply across personal accounts and organizations.

Subscribe the App to `workflow_job`, `workflow_run`, `installation`, `installation_repositories`, and `repository`. Set its webhook URL to `<RELAY_PUBLIC_URL>/webhooks/github` and OAuth callback to `<DASHBOARD_ORIGIN>/auth/github/callback`. Supply `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, plus secret bindings `GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLIENT_SECRET`, and `GITHUB_WEBHOOK_SECRET`. The PEM may be PKCS#1 or PKCS#8; escaped newlines are supported. Use `.dev.vars.example` as a local template and never commit a populated credentials file.

The dashboard must proxy `/api` and `/auth` while preserving `Cookie`, `Set-Cookie`, `Origin`, and redirects. Session cookies are HttpOnly, Secure, SameSite=Lax. Every operator write requires the exact configured dashboard Origin. OAuth state, enrollment tokens, and WebSocket tickets are consumed once. A GitHub installation alone does not grant dashboard access. The numeric owner check applies to every session read.

For scripted owner setup, `POST /auth/cli` accepts an existing GitHub **user** token in `Authorization: Bearer …` and the exact dashboard Origin. It verifies the user at GitHub and returns a normal one-hour session cookie. The supplied GitHub credential is never stored; do not print it, put it in shell history, or share the returned cookie jar. Browser OAuth sessions last fourteen days. Host tokens can be revoked from the dashboard.

## Execution and revision checks

Enrollment creates a paused host. Enable its repository only after GitHub confirms the required outside-contribution policy; public repositories require `all_external_contributors`. For private repositories, fork workflows must either be disabled or require approval. A failed policy lookup blocks enrollment/admission. The relay never silently enables repository-wide Actions.

Matching requires an explicit fleet platform label (`fleet-macos-arm64`, `fleet-macos-x64`, `fleet-linux-arm64`, or `fleet-linux-x64`) and every requested capability label. One physical host can hold one active lease. A lease's initial job is a capacity hint: GitHub may assign another compatible job. The mandatory pre-job admission request fetches the actual run and finds the in-progress job assigned to that exact unique runner name, rechecks repository enablement, capabilities, policy, and trust, and atomically binds the lease to that actual job. A second admitted lease cannot own the same job. The successful response supplies the actual identity that the agent must persist before uploading logs.

Verified repository writers may execute automatically. Outside authors require explicit owner approval. The original PR author remains the trust boundary after a maintainer rerun. Approval is pinned to repository, run, attempt, REST head SHA and current associated PR head revision. GitHub sometimes supplies an empty `workflow_run.pull_requests` array, so commit-to-PR association supplies the missing authoritative link. Changed PR heads cannot reuse an approval.

The hook's execution SHA is stored separately from the REST head SHA: PR workflows can execute a synthetic merge commit, while PR-target workflows execute the repository's default branch, including PRs targeting a different branch. The relay verifies a PR merge's second parent against the approved head. For PR-target, it resolves the default branch from authoritative repository metadata and verifies its current SHA or an ancestor through GitHub's compare API. The PR head/ref/repository association and original-author approval remain separate checks. Unknown associations fail closed, and admission denials record a diagnostic reason in the operator audit. An admitted job's returned `headSha` is the verified execution SHA; dashboard job metadata retains GitHub's canonical head SHA.

`expiresAt` is the unused registration deadline. An assigned in-progress job does not expire during slow action preparation or a long build. Unknown registration outcomes retain the slot until GitHub reconciliation proves the old runner is unstarted/offline or already finished. A temporarily unavailable assignment/recovery returns HTTP 503, which the agent's hook must retry without executing workflow steps. Permission/revision denials remain explicit denials. The patched runner must stop the entire job after admission failure, including steps using `if: always()`; the ordinary upstream hook failure behavior alone is insufficient.

JIT REST does not expose a disable-update option. `jit.ts` validates the pinned runner's base64 filename/config format, requires the expected runner name and ephemeral setting, and writes `.runner` `disableUpdate=true`, leaving every credential file's bytes unchanged. The agent verifies those settings again. This is coupled to the maintained upstream runner version; revalidate the format and update the patched binary within GitHub's supported runner update window. Ephemeral registration does not erase a native machine or provide isolation.

## Logs, history, recovery and bounds

Only the patched runner's already-masked console stream belongs in this API. `_diag` files and unmasked process output are not equivalent. The agent owns offline spooling. It holds raw records until the actual job binding is durable, uploads contiguous lease sequence numbers, and removes records only after an acknowledged sequence. The relay maps that identity to the GitHub numeric job ID, rejects sequence gaps/conflicting replay, and exposes a separate monotonic cursor for each job. Completed leases retain upload authorization so a relay outage can recover after the runner exits. A runner exit code does not determine workflow success; GitHub webhooks/API reconciliation determine conclusions.

Console records expire thirty days after durable receipt; completed job/control metadata expires after ninety days. The default retained log payload bound is 256 MiB, with 32 MiB per job (`MAX_LOG_BYTES`, `MAX_JOB_LOG_BYTES`). SQL indexes and storage overhead are additional provider usage. Accepted batches are acknowledged, then complete oldest records are evicted within the ingestion transaction to enforce these limits. Replay reports truncated history; acknowledgment confirms ingestion rather than indefinite retention. This implementation uses Durable Object SQLite only; it does not claim an R2 archive or infinite storage.

`GET /api/jobs/:id` reads a retained job. `GET /api/jobs` and `/api/audit` accept `limit` (1–500) and an opaque `cursor`; responses contain `items` and `nextCursor`. Overview initially includes the latest 500 jobs and 100 audit events. Log pages include `hasMore`, exact `nextCursor`, and `truncated` only when earlier retained history has been removed. Hibernating WebSockets provide new output and refresh notifications, while HTTP replay recovers missed records.

`GET /api/jobs/:id/failure-context` requires the same operator session and returns `{lines, notes}` for a stored job. It selects up to 12 earliest and 12 latest concrete error markers across the job's retained history, up to six neighboring records on either side, and up to 80 tail records. The result is chronological and capped at 400 records / 64 KiB of serialized UTF-8 JSON; long records are visibly shortened. Anchors take priority, the tail receives a bounded share, and remaining space carries nearby context. Notes distinguish retention gaps, selection limits, and text clipping. This heuristic excerpt may miss an unrecognized diagnostic and never claims to be complete history.

Selection scans the existing job/cursor index inside SQLite; only cursor IDs and small text windows enter JavaScript, in batches of at most 16 records. It adds no schema/index migration, GitHub log download, AI request, or additional log source: only the already-masked retained console records are eligible.

Signed webhook deliveries persist before processing and deduplicate by delivery ID, payload and event. Alarms retry reconciliation, recover uncertain leases, remove expired records, and close expired sessions' sockets. Enabled repositories receive a bounded recent-run reconciliation approximately every five minutes; webhooks supply normal live changes. Controls record requested and GitHub-accepted states separately. Cancellation/force-cancellation applies to runs, and job rerun uses GitHub's actual job endpoint.

Schema upgrades run in place, adding missing columns and rebuilding the actual-job uniqueness index without deleting hosts, credentials, history, or logs. Earlier approvals without a recorded PR revision require fresh approval. The initial release remains a single-owner, single-Durable-Object service: very large fleets/history volumes require deliberate sharding and additional cost planning. Local tests do not replace the real GitHub/Mac/Linux admission, cancellation, secret-masking, outage and upgrade pilots.
