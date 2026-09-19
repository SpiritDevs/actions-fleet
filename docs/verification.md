# Deployment verification

Verified on 2026-09-19. The dashboard is deployed at
[actions.spiritdevs.com](https://actions.spiritdevs.com) and the relay at
[api.actions.spiritdevs.com](https://api.actions.spiritdevs.com). Two physical
Apple Silicon Mac Studios are enrolled. Each has a user LaunchAgent and a
separate menu bar app in `~/Applications`, configured to open at login. Installed
agent/runner files live outside the source checkout; host credentials remain
in a 0600 configuration file within a 0700 state directory.

| Host | Mode exercised | Verified toolchains/capabilities |
| --- | --- | --- |
| Mac Studio | Dedicated | M2 Max, 32 GiB memory, native ARM64 runner and Apple Command Line Tools |
| Mac Studio (Xcode) | Shared | M2 Max, 32 GiB memory, Node 24.19.0, Rust 1.97.1, CMake 4.4.3, full Xcode 26.3 with macOS/iOS/visionOS 26.2 SDKs; `xcode` label |

## Real GitHub jobs

- [Managed pilot](https://github.com/SpiritDevs/actions-fleet/actions/runs/35400852783):
  passed through the installed host service. Shell, composite, JavaScript,
  Unicode, synthetic-secret masking, and artifact upload succeeded. All 2,286
  retained lines arrived in sequence, including final and cleanup output.
  A live socket received output before completion; after disconnecting it,
  cursor-based history recovered the missed lines.
- [Remote cancellation](https://github.com/SpiritDevs/actions-fleet/actions/runs/35401098544):
  the relay requested cancellation, GitHub confirmed the cancelled conclusion,
  all 231 log lines arrived in sequence, and the host reconciled and became idle.
- [Denied admission](https://github.com/SpiritDevs/actions-fleet/actions/runs/35398501182):
  a deliberately denied administrator hook prevented every contributed step,
  including `if: always()` output. This validates the patched execution gate;
  failure of an ordinary upstream hook alone is insufficient.
- [Pathway Release Smoke](https://github.com/SpiritDevs/pathway/actions/runs/35402122705/job/105784079587):
  passed every step on the second Mac in Shared mode, including checkout,
  Vite+ dependency/cache setup, release-only workflow checks, and post steps.
  GitHub identified runner `fleet-d0d53232-abb8780f-785`; the native worker's
  process priority was verified as `nice 10`. Relay logs arrived during execution.
  The first Mac simultaneously ran Test Server 1 from the same workflow,
  demonstrating compatible job assignment across two physical machines.

- [Pathway CI](https://github.com/SpiritDevs/pathway/actions/runs/35405815094)
  passed all six enabled jobs on commit `ae845ea32`: Check, general Test, all
  three server shards, and Release Smoke. The server shards recorded 3,988
  passing tests and 11 skipped tests. The Linux Rust lane was skipped as
  configured for the Mac-only rollout. The final migration head `8847b6572`
  also passed all six enabled jobs in
  [run 35409614904](https://github.com/SpiritDevs/pathway/actions/runs/35409614904).

- [Native dictation](https://github.com/SpiritDevs/pathway/actions/runs/35401583572)
  passed on the Command Line Tools Mac, including native Metal compilation,
  model/cancellation checks, and artifact upload.

- [Native iPhone](https://github.com/SpiritDevs/pathway/actions/runs/35408527166/job/105803215247)
  passed on the Xcode Mac at `7ee16bc9c`: the result bundle recorded 458 passing
  tests, zero failures, and zero skips. Both corrected Conversation fixtures
  passed. The operator subsequently cancelled the workflow; iPad had not
  started. The earlier visionOS job failed because its simulator runtime was
  absent. The ARM64 visionOS 26.2 runtime is now installed and available, and
  `8847b6572` adds the runtime prerequisite check, but the build retry remains
  unverified. The cancelled workflow was not restarted.

- [Pathway nightly](https://github.com/SpiritDevs/pathway/actions/runs/35404594588)
  attempt 2 built signed ARM64 artifacts on the Dedicated Mac. Production Convex
  deployment and Apple notarization succeeded; the shipped ZIP passed the
  Developer ID, team, ARM64, and stapled-ticket checks before upload. The public
  [nightly prerelease](https://github.com/SpiritDevs/pathway/releases/tag/v0.0.42-nightly.20260918.153)
  contains the DMG, ZIP, blockmaps, and nightly updater manifest. The independently
  downloaded public ZIP matched GitHub's SHA-256 digest and the updater
  manifest's size/SHA-512. Its extracted app passed deep/strict codesign, expected
  team, ARM64, version, and stapler validation without being launched. This
  release was built from `c6bc4cf23`. Its hosted-web job also completed
  successfully, deploying the nightly app to Vercel; the beta app returned
  HTTP 200. Native Apple UI lanes are separate checks.

The owner approved the staged `@spiritdevs/pathway@0.0.42` npm package with 2FA.
The public `latest` version and archive integrity matched the reviewed Apple
Silicon package. An isolated Node 24 installation, native install scripts,
`pathway --version`, and `pathway --help` passed without starting the app against
the owner's data. Subsequent stable CLI releases retain the manual npm approval
step.

An authenticated browser verified the deployed job history, both Mac cards,
available-memory display, WebSocket connection, and completed console output
without page errors. Both installed agents now report the optional available
memory field. A later authenticated browser check verified both local pauses
appear as “Paused on this machine” with no page errors; both services were then
resumed. Normal GitHub browser login was also exercised.

Job history displays an animated blue spinner while running, green success,
red failure, and gray queued indicators, with reduced-motion support. An
authenticated browser verified the actual colors and animation.

Failed-job sheets offer **Copy AI fix prompt**. On a real failed visionOS job,
the deployed dashboard copied the exact revision, failed-step metadata, links,
current machine inventory, and causal toolchain error from 72 retained excerpt
records into a 16,603-byte prompt. Console search filters did not remove that
evidence. Clipboard-denial and unavailable-history fallbacks also passed,
successful jobs hid the control, and no browser runtime errors occurred.

## Automated checks

The fleet's 117 tests passed across 14 files.
Workspace typechecks and builds passed. The pinned
runner's 25 focused C# tests passed, including actual Bash/sh invocation with
spaces and quote characters in paths. Native Swift menu model checks and its
build passed. A real Unix socket test covers the short, private job temporary
directory required by macOS’s socket-path limit. The runner also places its
checkout and GitHub command files in that private, space-free workspace; a real
Bash redirect test covers actions that use an unquoted `$GITHUB_OUTPUT`. Durable
runner state and log spools remain in the host state directory. Service plist
validation uses macOS `plutil`.

Shared admission retains its default CPU ceiling of 50% and minimum available
memory of 4 GiB. The second Mac initially waited because raw free memory was
about 1.2 GiB; the separate `memoryAvailableBytes` estimate reported about
13.7 GiB and admitted the successful job without changing those thresholds.
Tests cover macOS and Linux parsing, page-size/unit handling, invalid readings,
collection failures, and fallback to free memory when the optional field is
absent or unavailable. See the [host guide](../apps/agent/README.md) for the
calculation and its limits; it estimates headroom rather than reserving memory.

## Retention and operating bounds

The deployed relay retains console records for up to 30 days, bounded by
256 MiB for the fleet and 32 MiB per job. Accepted batches are acknowledged;
oldest records are evicted when byte limits are reached, and replay reports
truncation. Completed job/control metadata has a 90-day retention window.
These byte budgets cover log payloads; database indexes and other storage
overhead are additional provider usage. There is no R2 archive.

Each host has a default 256 MiB spool budget, including a raw capture cap of
64 MiB and a replay queue cap of 32 MiB per lease, with compaction headroom.
Each physical host admits one active job. Hosting, storage, network usage,
GitHub artifacts/caches, and electricity remain separate costs.

## Coverage limits

Two physical ARM64 Macs have been exercised concurrently. Native Linux support,
including its memory parser and service definition, is implemented, but no real
Linux host has been enrolled or validated. Intel Mac execution is also unverified.
The iPhone lane passed; iPad and the corrected visionOS build remain unverified
after the operator cancelled their validation run. The menu app is locally ad-hoc signed;
there is no notarized downloadable distribution yet.

Pathway CI and the signed nightly have the separate evidence above. A new stable
desktop version has not been published as part of validation; stable publication
remains a deliberate tag/manual release, with npm requiring the agreed human
approval. Track native Apple UI outcomes in the Pathway migration
runbook.
