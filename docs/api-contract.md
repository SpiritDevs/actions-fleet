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
- `GET /api/jobs/:id/failure-context` -> `FailureContext` (`{lines: LogLine[], notes: string[]}`). Authenticated, read-only diagnostic excerpts selected from retained masked logs, including early error context and the job tail. Notes describe selection, retention gaps, and size limits; this is not a full-log export. Used locally by the dashboard to prepare a copyable AI troubleshooting prompt, without calling an AI service.
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

For `pull_request_target`, execution is verified against the repository's
authoritative default-branch tip or its ancestry, as required by GitHub's
[default-branch execution change](https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/).
The PR's head/ref/repository association and original-author approval remain
separate requirements. A legacy PR base is not an alternate trusted execution
source. Admission denials record a fixed diagnostic reason and run/attempt in
the operator audit; they do not reveal credentials or bypass approval.

Errors: JSON `{error: string}` with appropriate HTTP status. No mock data or development bypass in production. The dashboard can show setup instructions when no App credentials are configured.

Host metrics include CPU usage, total/used memory, free disk, load average, and
CPU count. `memoryAvailableBytes` is an optional nonnegative byte estimate for
new-work admission; it does not redefine `memoryUsedBytes`. Updated agents bound
it to physical memory and fall back to free memory on collection failure. Shared
admission accepts older reports without the field using total minus used memory.
The dashboard shows available memory only when reported; it does not promise a
hard resource reservation.

Heartbeats and `Host` records optionally include `admissionReason` (string or
null, at most 160 characters). Agents send fixed admission messages only; local
errors and credentials are never included. Null or an omitted field clears the
previous message. This telemetry does not change the selected mode or let the
dashboard resume a machine paused locally.
