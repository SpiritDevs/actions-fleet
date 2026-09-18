# Actions Fleet

Native Mac/Linux GitHub Actions host service, Cloudflare relay, and Vercel dashboard. Read `docs/implementation-plan.md` for agreed scope and `docs/api-contract.md` for shared interfaces.

- Use Node 24 LTS and npm workspaces. `npm run typecheck`, `npm test`, and `npm run build` validate this repository.
- Keep shared wire types and runtime schemas in `packages/protocol`. Negotiate contract changes across consumers.
- Keep host credentials, GitHub App keys, captured workflow logs, and local machine state out of git and diagnostics. Examples contain placeholders only.
- Never kill processes by name or pattern. Stop only explicitly tracked child processes owned by this task/service.
- Jobs run natively; cleanup is not a security sandbox. Approval must be tied to the actual GitHub run revision before contributed steps execute.
- Do not enable hosted-runner fallback automatically. All repository workflows target self-hosted capacity or are manual.
- Keep the runner exporter additive, after upstream secret masking, and pinned to a reviewed upstream source revision.
- Do not claim deployment or real-run coverage from a local unit test, dry run, or mock.

Parallel agents should own separate directories. The integration owner handles root manifests, shared protocol, lockfile changes, repository publication, and deployment.
