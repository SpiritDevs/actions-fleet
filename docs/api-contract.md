# Initial service API contract

All operator routes use the HttpOnly session cookie through the dashboard's same-origin `/api` proxy. Mutations require the exact configured dashboard Origin. Browser WebSocket clients get a short-lived, one-use ticket from `POST /api/live-ticket`, then connect directly to the returned URL. Agent routes use `Authorization: Bearer <host token>`. All dates are ISO strings; shared records are in `packages/protocol/src/index.ts`.

Operator endpoints:
- `GET /api/session` -> `{viewer: Viewer|null, configured: boolean, loginUrl: string}`.
- `GET /auth/github`, `GET /auth/github/callback`, `POST /api/logout`.
- `POST /auth/cli` exchanges an existing GitHub user credential for a one-hour operator cookie. Exact dashboard Origin and numeric owner identity are required; the supplied GitHub credential is never stored.
- `GET /api/overview` -> `Overview`.
- `GET /api/jobs?limit=100&cursor=...` and `GET /api/audit?limit=100&cursor=...` -> `{items, nextCursor}`; opaque pagination cursors, maximum 500 items per page.
- `GET /api/jobs/:id` -> `Job`, including retained jobs outside the overview window.
- `GET /api/jobs/:id/logs?after=0` -> `{lines: LogLine[], nextCursor: number, truncated: boolean, hasMore: boolean}`. Cursor is per GitHub job identity.
- `POST /api/hosts/enrollment` `{name}` -> `{token, expiresAt, relayUrl}` (one-use token).
- `POST /api/hosts/:id/mode` `{mode}` -> `{ok: true}`; `DELETE /api/hosts/:id` revokes the host.
- `GET /api/connections/install` -> `{url}`; `POST /api/connections/sync` synchronizes installations/repositories the App can access.
- `POST /api/repositories/:id` `{enabled}` -> `{ok: true}`. Enrollment validates outside-contributor approval configuration.
- `POST /api/jobs/:id/control` `{action: 'cancel'|'force_cancel'|'rerun'|'rerun_failed'|'rerun_job'|'approve'}`. Control applies to the corresponding GitHub run/job, with actual scope shown in UI.
- `POST /api/live-ticket` -> `{url, expiresAt}`; socket messages follow `FleetEvent`.
- `POST /webhooks/github` validates raw-body HMAC signature and handles installation/repository/workflow_job/workflow_run events idempotently.

Host endpoints:
- `POST /agent/enroll` `{token, name, platform, architecture, labels, version}` -> `{hostId, token, mode}`.
- `POST /agent/heartbeat` heartbeat schema -> `{mode, revoked?: boolean}`.
- `POST /agent/claim` `{}` -> `{lease: Lease|null}`. One active lease per physical host; only enabled repositories and compatible approved jobs can create runner capacity. Relay creates one-job GitHub JIT registration; never send App/PAT credentials to agents.
- `POST /agent/leases/:id/complete` `{exitCode, error?: string}` -> `{ok:true}`.
- `POST /agent/logs` `{leaseId, lines: LogLine[]}` -> `{acknowledgedSequence: number}`. Sequences are scoped to one lease and strictly monotonic; retries deduplicate. Relay maps the runner GUID to the authoritative GitHub numeric job ID through the lease/run/runner name; do not trust an arbitrary supplied repository/job ID.
- `POST /agent/admission` `{leaseId, runId, runAttempt, headSha}` -> `{allowed:false}` or `{allowed:true, job:{jobId, repository, runId, runAttempt, headSha}}`. GitHub can assign a different compatible job from the original capacity hint. Bind logs only after this authoritative response; its SHA describes verified execution, while approval retains the canonical revision. HTTP 503/409 may be retried briefly while GitHub exposes the assignment; an explicit denial is final. The patched runner enforces denial before evaluating any contributed `always()` or post steps.

Errors: JSON `{error: string}` with appropriate HTTP status. No mock data or development bypass in production. The dashboard can show setup instructions when no App credentials are configured.

Host metrics include CPU usage, total/used memory, free disk, load average, and
CPU count. `memoryAvailableBytes` is an optional nonnegative byte estimate for
new-work admission; it does not redefine `memoryUsedBytes`. Updated agents bound
it to physical memory and fall back to free memory on collection failure. Shared
admission accepts older reports without the field using total minus used memory.
The dashboard shows available memory only when reported; it does not promise a
hard resource reservation.
