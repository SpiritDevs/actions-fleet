# Deployment verification

Verified on 2026-09-19. The dashboard is deployed at
https://actions.spiritdevs.com and the relay at
https://api.actions.spiritdevs.com. The first enrolled host is an Apple Silicon
Mac Studio. Its agent runs as a user LaunchAgent, with the separate menu bar
app installed in `~/Applications` and configured to open at login.

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

An authenticated browser verified the deployed job history, Mac status,
WebSocket connection, and completed console output without page errors. Normal
GitHub browser login was also exercised.

## Automated checks

The fleet's 77 tests, workspace typechecks, and builds passed. The pinned
runner's 25 focused C# tests passed, including actual Bash/sh invocation with
spaces and quote characters in paths. Native Swift menu model checks and its
build passed. Service plist validation uses macOS `plutil`.

## Coverage limits

Only one physical Mac has been enrolled and exercised. Native Linux support and
multi-host admission have automated coverage; real Linux and multiple-machine
operation still require those machines to be enrolled. Full Xcode is absent on
this Mac, so it does not advertise the `xcode` capability. The menu app is locally
ad-hoc signed; there is no notarized downloadable distribution yet.

Pilot checks do not establish that a Pathway signed release or every existing
Pathway test succeeds. Track those separately in the Pathway migration runbook.
