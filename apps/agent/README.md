# Native host agent

The agent runs one ephemeral GitHub Actions runner at a time on a Mac or Linux
host. Jobs run natively as the service's OS user. Use a dedicated CI account and
install that project's normal toolchains in that account. Separate workspaces
and an environment allowlist do not isolate arbitrary code from that user's
files, login keychain, network, or other processes.

Node.js 22.14 or later is required; use a supported LTS release. The runner
template must be built by this repository's runner build script and contain
`.fleet-runner.json` with `exportProtocol: 1` and `admissionProtocol: 1`. It must be unregistered. Its OS and
architecture must match the host. Each lease receives a separate copy; the JIT
settings must name the expected runner, enable ephemeral execution, and disable
automatic updates so an upstream update cannot replace the masked exporter.

From the repository root, after installing workspace dependencies:

```sh
npm run build --workspace @actions-fleet/agent
npm run agent -- enroll --relay-url https://YOUR-RELAY --name "Mac Studio" --runner-directory /absolute/path/to/patched/runner
npm run agent -- run
```

Enrollment reads the dashboard's one-use token from standard input. Automation
can supply `FLEET_ENROLLMENT_TOKEN`; the agent removes it from its own environment
after reading it. Never put persistent host credentials in a workflow or shell
command. Enrollment stores them in a 0600 configuration file inside a 0700 state
directory. Default locations are `~/Library/Application Support/Actions Fleet`
on macOS and `~/.local/state/actions-fleet` on Linux. Every public command accepts
`--state-dir /absolute/path` for another location.

The dashboard initially pauses new hosts. Select Dedicated or Shared there when
the host is ready. `pause` stops local admission while active work finishes;
`resume` removes the local pause and follows the dashboard mode. `status` prints
the current nonsecret status JSON. The Mac menu app consumes that same atomic
`status.json`; it can write `control.json` containing `{"paused":true}` or
`{"paused":false}` atomically with 0600 permissions. A stale `updatedAt` means
the status is no longer a live health report. Quitting the menu app does not stop
the host service.

Shared mode waits for CPU usage at or below 50% and at least 4 GiB free memory,
then starts the runner with `nice -n 10` and conservative build-tool concurrency
environment variables. The private config can adjust these thresholds. Tools
can override those variables; these are admission and priority controls, not
hard CPU or memory caps. Both modes wait below 1 GiB free disk space. Configured
labels describe installed capabilities; enrollment advertises the appropriate
`fleet-macos-arm64`, `fleet-macos-x64`, `fleet-linux-arm64`, or `fleet-linux-x64`
label automatically. Add other capabilities using repeatable `--label` options.

Each runner gets a private short `TMPDIR` under `/tmp/actions-fleet-native-host`
so nested Unix socket paths fit macOS's path limit. The host lock records those
directories and removes only its recorded resources after the runner exits;
recovery preserves them while a previous runner is still alive.

## Service installation

`npm run agent -- service-files` generates a user-scoped service definition in
the state directory. It does not install, enable, or start it. It pins the
current Node binary, agent bundle, state directory, and PATH; regenerate after
moving or upgrading those files. Do not delete the repository while using that
generated service.

The macOS service uses launchd's `Interactive` process classification, matching
GitHub's official runner service, so launchd does not impose background CPU/I/O
throttling on Dedicated builds or agent heartbeats. Shared jobs still receive
the runner-specific priority and concurrency controls described above.

On macOS, copy the generated `com.actions-fleet.agent.plist` to
`~/Library/LaunchAgents/`, then load it with:

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.actions-fleet.agent.plist"
```

Use `launchctl bootout "gui/$(id -u)/com.actions-fleet.agent"` to unload it. A user
LaunchAgent starts after that account logs in. Login, sleep, power, and keychain
availability affect native build capacity. Launchd's generated stop grace is
two hours; pause and wait for an idle status before an intentional unload.

On Linux, copy the generated `actions-fleet-agent.service` to
`~/.config/systemd/user/`, then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now actions-fleet-agent
```

Use `systemctl --user disable --now actions-fleet-agent` to stop and disable it.
User services require an active user manager; persistent service operation
after logout may require the administrator's normal linger configuration.
The generated unit drains indefinitely on a normal stop and uses `KillMode=process`
so the already-running helper can finish if the agent crashes.

## Recovery and log bounds

The agent reserves loopback port 47381 and a private record under
`/tmp/actions-fleet-native-host` for one physical-host slot, across state
directories and users. If another user's record is inaccessible, startup fails
closed. A surviving runner helper also blocks a replacement agent until it
finishes. Do not delete the lock or kill unrelated processes to bypass this.
The trusted hook wrapper also lives in that private directory because the
official runner invokes its hook path without quoting spaces. The wrapper
quotes the real Node and agent paths, so the default Mac state directory and
installation directories may contain spaces. Hook files are 0700, created
exclusively, recorded in the host lock, and removed only after their runner
finishes or a later startup proves no previous runner remains.
If a stale PID has been reused, an operator must inspect that process before
removing the stale record. Normal SIGINT/SIGTERM stops admission and drains the
current job. The agent never uses a process-name kill or global workspace cleanup.

The pre-job hook receives only a random, one-lease local admission capability.
It verifies the actual assigned run, attempt, and SHA with the relay before
contributed steps. A claim is initially a capacity hint: GitHub can assign
another compatible job. The relay verifies that assignment and the agent
persists its authoritative identity before sequencing or uploading any output.
The patched runner enforces hook success even for later `if: always()` steps;
a standard runner hook alone is insufficient. Temporary assignment visibility
and recovery responses retry for at most 60 seconds. Explicit denial never
retries or permits contributed steps.
Host management tokens and unrelated supervisor environment variables never
enter the runner environment. A relay outage denies new admission while active
work finishes. Registration expiry controls when startup may begin; it does not
terminate an already-running GitHub job.

The patched runner writes masked records promptly. The agent tails complete
UTF-8 records, commits monotonically sequenced events and offsets to disk,
uploads bounded batches, and compacts only acknowledged events. A partial final
record, malformed record, full replay queue, or exporter I/O sentinel creates
an explicit collector error or gap. The raw capture has its own fixed cap and
does not rotate while the runner owns its file. Full output remains available
in GitHub's normal log service if local capture stops.

The default total spool budget is 256 MiB. Raw capture reserves at most 64 MiB
and the replay queue at most 32 MiB per lease; atomic compaction and metadata
have separate headroom.
The agent completes replay/reconciliation before claiming another lease. Data
rejected because its GitHub job identity cannot be verified is quarantined in
place with `quarantine.json`, remains within the total budget, and appears as a
status error. Review it locally before removing that exact lease directory;
there is no automatic discard of unacknowledged rejected logs. A full spool
pauses new admission. A full filesystem may also prevent status/error files
from being updated; inspect the service's local stderr when status becomes stale.

After a crash, leases are never rerun. If no live helper remains and no completion
receipt exists, the agent reports an unknown runner outcome and reconciles the
remaining spool. GitHub remains authoritative for job success and cancellation:
runner process exit zero is not proof that workflow steps passed. Native jobs
can launch processes outside a normal process tree; the official runner's own
job cleanup runs first, and this service removes only its marked lease directory.

## Status schema

`status.json` contains `schemaVersion: 1`, `hostId`, `name`, `pid`, `updatedAt`,
`connectionStatus` (`connected`, `disconnected`, `revoked`, `stopped`), remote
`mode`, `localModeOverride` (`paused` or null), `effectiveMode`, host `metrics`,
and `currentJob` (null or `{id, runId, runAttempt, repository, htmlUrl}`). Optional
`error` and `admissionReason` explain degraded collection or blocked admission.
It never includes the host token, enrollment token, or JIT configuration.

Run focused tests from the repository root with
`npx vitest run apps/agent/test`; these use disposable local fake runners and
exercise the actual helper, hook, replay queue, and relay-loss behavior without
registering a GitHub runner.
