# Actions Fleet menu bar app

A small native Swift/AppKit app for macOS 13 or later. It shows an icon in the menu bar, the current machine’s relay connection, effective build mode, running job, and host resource usage. The icon shows `1` while a job is running. GitHub and live-log menu items open the real job in your browser.

Build locally on a Mac with Apple Command Line Tools:

```sh
sh apps/menubar/build.sh
sh apps/menubar/test.sh
```

The output is `apps/menubar/dist/Actions Fleet.app`. Copy it into `~/Applications` and open it. Use **Settings…** to set your deployed dashboard URL. macOS **System Settings → General → Login Items** can open the app at login. Building does not launch the app or install a background service. The bundle is locally ad-hoc signed; a downloadable distribution would need Developer ID signing and notarization.

The default agent state directory is `~/Library/Application Support/Actions Fleet`. A menu bar instance monitors one local host service. Set a different state directory in Settings if the host service uses another location; run the app as the same macOS user as that service. Optional launch arguments are `--state-directory /absolute/path`, `--dashboard-url https://fleet.example.com`, and `--config /absolute/path/preferences.json`. CLI overrides apply after saved preferences. The menu bar stores only nonsecret preferences in `~/Library/Application Support/Actions Fleet/MenuBar/preferences.json` by default.

Every two seconds the app reads the agent’s atomic `status.json`, schema version 1. Reports older than 30 seconds are shown as stale, and an old job is labelled **Last reported job** rather than running. The app never reads `config.json`, host tokens, runner credentials, or diagnostic logs.

**Pause new jobs on this Mac** writes the documented `{ "paused": true }` local control to `control.json` atomically with owner-only permissions. Existing jobs finish. **Resume local admission** clears that local override; the dashboard’s Dedicated, Shared, or Paused mode remains authoritative. **Manage machine modes…** opens the authenticated dashboard. These operations do not execute shell commands or signal processes.

**Quit menu bar app** closes the menu bar interface. The separately installed host service and its active build continue running. Use the host service’s documented stop/drain command to stop build service work.
