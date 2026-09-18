# Fleet feasibility gates

These validation gates support the consolidated [implementation plan](./implementation-plan.md), which awaits final shared-understanding confirmation. The selected topology is recorded in [ADR 0004](./adr/0004-host-the-fleet-relay-on-cloudflare.md), and native execution in [ADR 0005](./adr/0005-run-jobs-natively-on-fleet-hosts.md).

## First proof: complete live console output

Live console logs inside the dashboard are required. The inspected official runner has no documented general-purpose console export hook; internal temporary log files do not establish prompt, lossless capture. The user accepts a minimal additive export after the runner's own masking if necessary, without an added paid-service/licensing requirement. The extension still needs proof and an update process.

Prove collection before building the full dashboard:

- Capture quiet steps as they run, rapid short steps, high-volume output, and interleaved output from concurrent jobs.
- Preserve repository, run attempt, job, step, and sequence identity, including setup and post-job phases.
- Cover shell, JavaScript, and composite actions on macOS and Linux; cover Docker actions on Linux.
- Use dummy secrets to verify GitHub-equivalent masking before local persistence or network export.
- Disconnect the relay and reconnect: replay acknowledged history without silent gaps or duplicate display, within a bounded host spool.
- Show collector failure explicitly; avoid changing a job's result merely because its dashboard stream disconnects.
- Verify cancellation and worker shutdown preserve the completed log tail.
- Keep GitHub's normal console and checks working alongside the additional export.

Do not present runner diagnostic traces as workflow console output or substitute completed-log downloads for this proof.

## Execution proof

Jobs run natively on persistent hosts. Start with one active job per physical machine; VM isolation is out of scope. One-job runner registration does not wipe a machine, and workspace cleanup must not be represented as a security sandbox.

For each supported environment, prove:

- Each job receives its intended workspace; job-owned background processes and temporary credentials are cleaned up by tracked identity. Persistent tools/caches remain intentional, and unrelated local data is untouched.
- Shared mode moderates native execution through admission, priority, and supported tool settings; verify its practical behavior without claiming hard CPU/RAM isolation.
- Paused mode admits no new jobs and allows current jobs to finish.
- Physical-host admission prevents Pathway server shards from running concurrently on the same machine.
- An unapproved outside contribution cannot acquire execution capacity; approval cannot accidentally authorize later changed code.
- Hosts expose accurate OS/architecture capabilities, and incompatible jobs remain queued with a clear explanation.

Only the current M2 Max has been inspected. Actual remote Linux and other Mac capability checks will be needed during enrollment; support cannot be inferred merely from another machine being present.

## Relay and dashboard proof

- Authenticate the sole initial operator with GitHub and reject other logins until explicitly admitted.
- Connect selected repositories under separate GitHub owners/organizations without crossing their authorization boundaries.
- Enroll hosts with distinct revocable identities and keep host-management credentials outside job environments.
- Persist host mode and command audit records; distinguish requested controls from acknowledged results.
- Exercise supported GitHub workflow cancellation and rerun operations with their actual scope, including dependent jobs on rerun.
- Display host loss, relay loss, reconnect, log replay, and storage exhaustion explicitly.
- Verify 30-day console and 90-day metadata/audit retention and measure actual usage before production cost claims.

## Migration proof

Use a dedicated pilot workflow before moving production signing or deployment work. Validate both macOS and Linux execution, then compare relevant Pathway checks with the intended restored baseline. Preserve required-check identities and artifact behavior when routing changes. Keep the user-selected manual hosted fallback explicit.

The fleet product still supports Mac and Linux hosts, but the initial Pathway rollout is Mac-only: skip Linux/Windows-specific work, as explicitly selected by the user. Do not silently use hosted compute for those jobs. Portable release support jobs that happen to use Ubuntu labels must receive macOS-compatible implementations so their outputs continue to unblock Mac builds and publication.

The user explicitly requires reactivating disabled Pathway workflows, publishing nightly/stable Apple Silicon desktop builds to GitHub Releases, and restoring npm CLI publication. Intel Mac desktop downloads are deferred. Restore the audited triggers on current main without copying a stale workflow wholesale. Preserve signing/notarization, release channels/tags, updater manifests, asset names, publication permissions, and existing channel-specific deployment behavior.

Prove npm package contents independently of the desktop matrix: the initial published CLI is explicitly Apple Silicon Mac-only. Verify the ARM64 resource monitor and `os`/`cpu` restrictions in the final package. Preserve independent GitHub Release and stable version-finalization dependencies so a pending npm publication does not block the Mac app. The user chose automatic build/staging on the Mac followed by operator approval in npm with 2FA. Report staged and published as distinct outcomes and verify the published version before claiming npm completion. Check package/account prerequisites during setup and bootstrap a new package before relying on staging.

Validate publication preparation and artifact contents before triggering a real production release. A dry run or draft release is a useful staging proof; it is not by itself proof that all production side effects have succeeded. Rebase or otherwise choose the intended Pathway revision before making migration edits.

Repository-wide GitHub Actions is currently disabled even though individual workflow records are active. Restore labels, job conditions, dependencies, and triggers before enabling repository-wide Actions; enabling it first could restart existing Blacksmith work. For skipped jobs that participate in required checks or release dependencies, preserve correct gating: a skip must not accidentally certify unrun tests or block the intended Mac publication path.
