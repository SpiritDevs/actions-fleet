# Masked console export and mandatory admission

Actions Fleet adds an opt-in exporter and admission gate to the MIT-licensed [official runner](https://github.com/actions/runner). The pinned upstream commit is in `version.json`. The build script checks the revision and insertion points, adds the two source files and focused admission tests, and builds a self-contained runner layout. Its marker includes `exportProtocol: 1` and `admissionProtocol: 1`; the host agent requires both.

Run `node scripts/build-runner.mjs` on the target Mac/Linux architecture. Upstream's build script downloads its pinned .NET SDK into the ignored local source cache. Point the agent's runner template at the printed `_layout` path. The agent makes a separate copy for every JIT lease. Do not point it at an already-registered developer runner.

The export receives `msg` only after `HostContext.SecretMasker.MaskSecrets` in `ExecutionContext.Write`. GitHub's normal console upload stays intact. `FLEET_LOG_PATH` selects an append-only NDJSON file. Each record contains run/attempt, runner job GUID, step GUID, timestamp, and masked output. The agent supplies durable sequence numbers and maps the lease to the GitHub job identity. The file flushes after every record, including quiet short steps and post-job output.

`FLEET_LOG_MAX_BYTES` bounds capture (default 64 MiB). On reaching the limit, one explicit gap record is appended; the remaining output stays in GitHub Actions. No raw-file rotation occurs. Disk errors stop the optional collector, emit a fixed diagnostic, and attempt an adjacent `.error` sentinel; they must not fail the workflow. File flush is not a guarantee against storage/hardware loss.

Keep this patch current with upstream required runner updates. Rebuild and run the capture/masking/replay pilot before promoting a new template. JIT runner copies must disable independent updates so they cannot silently replace the collector; template maintenance owns upgrades. This fork extension has no paid license or separate service dependency.

`FLEET_REQUIRE_ADMISSION=1` enables the mandatory gate. Before evaluating any
contributed step, the runner requires its first executable item to be the exact
administrator-configured pre-job hook. The hook must complete successfully.
A missing, failed, canceled, or skipped hook fails the job and skips every
remaining contributed and post step without evaluating their conditions or
environment. This includes `if: always()` and `if: failure()`. The ordinary
GitHub pre-job hook alone does not enforce this boundary. When the Fleet option
is absent, upstream execution semantics are preserved.

`FleetAdmissionGateL0.cs` extends upstream's real `StepsRunnerL0` harness to test
the actual condition/dispatch path. After applying/building the patch, run it
with the pinned local SDK, from `.cache/runner-src/src`:

```sh
../_dotnetsdk/8.0.424/dotnet test Test/Test.csproj -c Release -p:PackageRuntime=osx-arm64 --filter 'FullyQualifiedName~StepsRunnerL0'
```

Use the matching `PackageRuntime` on Linux or Intel Mac. The GitHub pilot must
also deny an actual job containing unconditional/always steps and confirm that
none executed, then prove ordinary steps and post actions still run after
successful admission.

Source-file and isolated exporter checks are not proof of real GitHub job capture. The pilot must cover setup, shell/JavaScript/composite steps, post steps, cancellation, secret masking, short/quiet output, volume, disconnects, and final-tail replay. Docker actions additionally need a Linux host.

The pinned upstream `ScriptHandler` also leaves `{0}` unquoted in its Unix
bash/sh/python argument templates. `FleetShellArguments` quotes unquoted script
placeholders before handing the string to .NET's argument parser, preserving
already-quoted custom templates and PowerShell command templates. This keeps
the default Mac state directory (`Application Support/Actions Fleet`) usable
when script paths contain spaces. The agent separately uses a private,
space-free checkout and command-file directory for third-party actions that
assume unquoted paths. Windows argument handling remains upstream's.
The runner marker records `shellPathProtocol: 1`. The focused
`FleetShellArgumentsL0` tests execute real Bash and sh through .NET with spaces,
double quotes, and apostrophes in the script path; the live pilot additionally
covers ordinary and composite shell steps under the default Mac state path.
