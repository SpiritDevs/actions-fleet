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

An authenticated browser verified the deployed job history, both Mac cards,
available-memory display, WebSocket connection, and completed console output
without page errors. Both installed agents now report the optional available
memory field. Normal GitHub browser login was also exercised.

## Automated checks

The fleet's 94 tests passed across 11 files.
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
Full Xcode and SDK discovery passed on the second Mac; that alone does not prove
the native iOS/visionOS workflow lanes. The menu app is locally ad-hoc signed;
there is no notarized downloadable distribution yet.

Pilot checks do not establish that a Pathway signed release or every existing
Pathway test succeeds. Track those separately in the Pathway migration runbook.
