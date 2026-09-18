# Pathway migration and workflow restoration

Read-only audit on 2026-09-19 against main `6590b42077188c0e5e2141fb4b0d584f2413737b`. The local checkout is older; edit current main or an isolated checkout based on it, not the stale workflow copies.

## Required outcome

Run the initial Pathway rollout natively on the available Macs, re-enable intentionally paused automation, and preserve nightly and production Apple Silicon Mac app publication to GitHub Releases. Restore npm CLI publication too, explicitly supporting Apple Silicon Macs only initially. Skip Linux/Windows-specific workflow jobs during this rollout; Intel Mac desktop downloads remain excluded initially. The fleet product itself still supports native Linux hosts.

An Ubuntu runner label does not necessarily make a step Linux-specific. Release preparation, metadata, upload, and publication must receive macOS-compatible implementations so Mac builds have the prerequisite outputs they need. Platform-neutral checks and tests are also candidates to retain on Macs; explicitly Linux-specific tests remain skipped.

## Two layers of disablement

The repository Actions setting reports `enabled: false`; all 10 individual workflow records report `active`. Several YAML triggers were removed separately. Update routing, conditions, dependencies, and restored triggers before enabling repository-wide Actions, otherwise current scheduled/push jobs can resume on Blacksmith.

## Workflow inventory

| Workflow | Current trigger | Restoration and Mac behavior |
| --- | --- | --- |
| CI | Manual | Restore PR and main-push triggers. Port portable check/JS/server/release-smoke steps to Mac; replace Linux toolchain installation with a verified Mac toolchain. Keep Linux KDE/Hyprland Rust-specific checks excluded. |
| Issue Labels | Manual | Restore path-filtered main pushes for issue-template/workflow changes; keep manual access. Portable API work. |
| PR Size | Manual | Restore PR-target events; preserve metadata-only behavior and permissions. |
| PR Vouch | Manual | Restore PR-target events, issue-comment creation, and relevant main pushes. Its labels are not themselves an execution approval gate. |
| Web Preview | Manual | Restore same-repository PR labeled/synchronize/reopened events with the existing `preview:web` condition. Portable Vercel CLI work. |
| Native Apple clients | Manual | Restore path-filtered PR triggers. Keep iPhone/iPad/visionOS lanes on compatible Apple Silicon hosts with full Xcode/SDK/simulator prerequisites. |
| Native dictation | Manual and path-filtered PR | Keep Mac lane and explicitly exclude Windows lane. |
| Deploy Pathway Connect relay | Path-filtered main push | Retain the current path filters and port native CLI execution to Mac. |
| Check private mail storage | Manual | Remain manual; no removed automatic trigger was found. |
| Release | Three-hour schedule and manual; nightly only | Preserve Apple Silicon Mac nightly behavior and restore the intended stable channel, triggers, publication metadata, and npm CLI publication. Port required Ubuntu-labeled support jobs to Mac. |

Sources: [current workflows](https://github.com/SpiritDevs/pathway/tree/6590b42077188c0e5e2141fb4b0d584f2413737b/.github/workflows), [CI/metadata/preview trigger removal](https://github.com/SpiritDevs/pathway/commit/112499493eb357760732d683ea1be06d4aecf30e), [Apple PR trigger removal](https://github.com/SpiritDevs/pathway/commit/721f1d560155265b6df83b53526f629d930a75f8).

## Release dependencies and invariants

The [nightly-only change](https://github.com/SpiritDevs/pathway/commit/4ff6b806d57542b8c294ce3096619069396de12e) removed stable tag/manual channel inputs, stable version and tag resolution, CLI dist-tag output, stable/latest metadata, and channel-specific concurrency. It also removed Intel Mac/Linux/Windows build entries and some platform-specific preparation/manifest handling. Restoring a tag trigger alone does not restore stable publication.

Required behavior:

- Preserve signing and notarization. A build must not silently become unsigned because it moved off Blacksmith.
- Preserve DMG/ZIP assets, blockmaps, channel updater metadata, expected asset names, and GitHub Release upload permissions.
- Nightlies remain prereleases and do not replace the stable `latest` release.
- Version resolution currently uses GNU `date -d`; provide a portable alternative for Mac execution.
- Keep change detection, preflight, public config, build, artifact upload, and publication dependencies intact. Removing a Linux/Windows lane must not remove required outputs for the Mac lane.
- The desktop build also deploys the configured Convex backend. Preserve the intended backend/channel configuration, and distinguish a build-only proof from a real deployment.
- Stable hosted-web behavior differs from current nightly-only `beta` deployment; restore the intended historical channel behavior if included in production restoration.
- Use unique job workspaces and temporary signing material. Track and clean up only job-owned state. Do not run against the developer's live checkout or Pathway userdata.
- Begin with one active job per physical host; native server shards and shared simulator use are not isolated merely because runner processes have different names.

Skipping unsupported Pathway platform lanes is an explicit workflow migration choice, not a fleet-wide rule to silently skip any unmatched job. Other enrolled repositories retain GitHub's normal queue behavior when no compatible host is available. A manual hosted fallback remains available only when deliberately selected.

The latest observed nightly has Apple Silicon Mac assets only. GitHub's `releases/latest` endpoint returned 404 during this audit, so there is no verified current published stable/latest baseline. [Observed nightly](https://github.com/SpiritDevs/pathway/releases/tag/v0.0.42-nightly.20260915.152).

## Agreed publication scope

- Q21: Apple Silicon desktop downloads only initially, for both nightly and stable releases. Intel Mac downloads are deferred.
- Q22: restore npm CLI publication as part of the initial rollout; do not leave it dormant.
- Q23: build and stage stable npm packages on a Mac, then require the operator to approve publication in npm with 2FA. GitHub desktop release publication remains automated.
- Q24: the initial published npm CLI supports Apple Silicon Macs only. Intel Mac, Linux, and Windows CLI support are deferred.
- The current GitHub Release job depends on preflight/build, and stable version finalization depends on preflight/release; neither depends on npm publication. Preserve that separation, while reporting npm's own result accurately.

Desktop download scope and npm CLI installation support are separate decisions; the user selected Apple Silicon only for both. Linux/Windows workflow jobs remain skipped in the initial Mac rollout.

## npm publication constraints

The current CLI helper calls `vp pm publish`; its provenance flag defaults to false and the release workflow does not enable it. Its authentication must be configured explicitly if this dormant job is restored. It also bundles whichever resource-monitor artifacts the desktop build matrix produced, without checking a complete platform set. With only the current ARM64 Mac matrix entry, a published package can omit monitors for other platforms. Runtime resolution can then return `ResourceMonitorBinaryNotFound`; this establishes missing telemetry support, not that the whole CLI cannot start. [Artifact bundling](https://github.com/SpiritDevs/pathway/blob/6590b42077188c0e5e2141fb4b0d584f2413737b/.github/workflows/release.yml#L549), [runtime resolution](https://github.com/SpiritDevs/pathway/blob/6590b42077188c0e5e2141fb4b0d584f2413737b/apps/server/src/resourceTelemetry/ResourceMonitorBinary.ts#L138).

npm trusted publishing currently excludes self-hosted runners. Its current token documentation says direct publication through granular access tokens will be removed in January 2027; the documented continuing token path stages a version for a maintainer to approve with 2FA. Do not design durable, fully automatic npm publication around the expiring direct-token path. This registry-specific limitation does not prevent automated Mac app publication to GitHub Releases. [Trusted publishers](https://docs.npmjs.com/trusted-publishers/), [access tokens](https://docs.npmjs.com/about-access-tokens/).

Staged uploads are not published releases; the dashboard and workflow must distinguish those states. Use npm's documented staging flow with a suitably scoped staging token. Preserve the generated package metadata and dependency resolution currently handled by the CLI helper, and validate the actual package before staging. Staging requires npm CLI 11.15.0 or newer and Node 22.14.0 or newer. [Staged publishing](https://docs.npmjs.com/staged-publishing/).

An unauthenticated public registry lookup for `@spiritdevs/pathway` returned HTTP 404 on 2026-09-19. This does not distinguish an absent/unpublished package from one hidden by access controls. Verify through the publishing account during setup. npm staging requires an already-existing package, so a new package needs an initial publication before that flow is available. [Staging prerequisites](https://docs.npmjs.com/staged-publishing/).

## Initial CLI platform support

Q24 is agreed: explicitly support Apple Silicon Macs only in the initial npm CLI. Cross-platform CLI coverage is deferred independently of the desktop release matrix and generic fleet host support.

The published metadata currently has no `os` or `cpu` restriction. Add `os: ["darwin"]` and `cpu: ["arm64"]` to the published package metadata generated by `apps/server/scripts/cli.ts`, document the support boundary, and verify those fields and the ARM64 resource monitor in the packed artifact. Check the final transformed manifest rather than assuming source fields survive the publishing helper. Avoid unnecessarily restricting installation of the development workspace on other operating systems; the selected restriction concerns the published CLI.

Future cross-platform CLI coverage can separate resource-monitor builds from desktop packaging. The crate uses `serde`, `serde_json`, and `sysinfo`. Mac-hosted Linux compilation with Zig/`cargo-zigbuild`, and Windows MSVC compilation with `cargo-xwin` plus the relevant SDK/toolchain, are documented candidates, not verified Pathway builds. Adding Rust targets alone is insufficient to provision cross-linkers. Require actual build proofs and identify target-runtime validation gaps before expanding supported installation platforms. These cross-compilation tools are outside the initial implementation scope. [Rust cross-compilation](https://rust-lang.github.io/rustup/cross-compilation.html), [cargo-zigbuild](https://github.com/rust-cross/cargo-zigbuild), [cargo-xwin](https://github.com/rust-cross/cargo-xwin).

Other platform-specific CLI dependencies, including `node-pty`, `@ff-labs/fff-node`, and agent SDKs, remain external npm dependencies selected or built for the consumer's platform. The native assets explicitly injected into Pathway's own package are the resource-monitor binaries; changing the publishing host alone does not require rebuilding all dependency binaries for every platform.

No workflow settings, builds, releases, or deployments were changed by this audit.
