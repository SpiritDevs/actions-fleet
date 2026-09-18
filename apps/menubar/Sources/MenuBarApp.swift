import AppKit
import Foundation

@main
struct ActionsFleetMenuBar {
    static func main() {
        let application = NSApplication.shared
        let delegate = MenuBarController()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        application.run()
        withExtendedLifetime(delegate) {}
    }
}

final class MenuBarController: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private var timer: Timer?
    private var status: PublicStatus?
    private var readError: String?
    private var preferences = Preferences.defaults
    private var preferencesURL = URL(fileURLWithPath: Preferences.defaultStateDirectory, isDirectory: true)
        .appendingPathComponent("MenuBar/preferences.json")
    private var requestedPause: Bool?
    private var menuIsOpen = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        parseArguments()
        if let data = try? Data(contentsOf: preferencesURL), let saved = try? JSONDecoder().decode(Preferences.self, from: data) {
            preferences = saved
        }
        // Explicit CLI overrides are useful for a separate CI user or a local relay.
        parseArguments()
        menu.delegate = self
        menu.autoenablesItems = false
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.menu = menu
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
    }

    private func parseArguments() {
        let args = Array(CommandLine.arguments.dropFirst())
        var index = 0
        while index + 1 < args.count {
            switch args[index] {
            case "--config": preferencesURL = URL(fileURLWithPath: (args[index + 1] as NSString).expandingTildeInPath)
            case "--state-directory": preferences.stateDirectory = args[index + 1]
            case "--dashboard-url": preferences.dashboardURL = args[index + 1]
            default: break
            }
            index += 2
        }
    }

    func menuWillOpen(_ menu: NSMenu) { refresh(); menuIsOpen = true }
    func menuDidClose(_ menu: NSMenu) { menuIsOpen = false }

    @objc private func refresh() {
        do {
            let file = preferences.stateURL.appendingPathComponent("status.json")
            let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? 0) <= 256_000 else {
                throw CocoaError(.fileReadCorruptFile)
            }
            status = try PublicStatus.decode(Data(contentsOf: file))
            readError = nil
            if let requestedPause, (status?.localModeOverride == .paused) == requestedPause { self.requestedPause = nil }
        } catch {
            status = nil
            readError = FileManager.default.fileExists(atPath: preferences.stateURL.appendingPathComponent("status.json").path)
                ? "The agent status file could not be read."
                : "Waiting for the host service."
        }
        updateIcon()
        // Rebuilding a menu while it is being tracked would discard keyboard
        // selection. The status icon stays current; each opening gets fresh rows.
        if !menuIsOpen { rebuildMenu() }
    }

    private func updateIcon() {
        guard let button = statusItem.button else { return }
        let fresh = status?.isFresh() == true
        let paused = status?.effectiveMode == .paused
        let active = fresh && status?.currentJob != nil
        let symbol = active ? "shippingbox.fill" : paused && fresh ? "pause.circle" : "shippingbox"
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Actions Fleet")
        image?.isTemplate = true
        button.image = image
        button.imagePosition = .imageLeading
        button.title = active ? " 1" : ""
        button.toolTip = "Actions Fleet — \(connectionDescription)"
        button.setAccessibilityLabel("Actions Fleet, \(connectionDescription)\(active ? ", one active job" : "")")
    }

    private var connectionDescription: String {
        guard let status else { return "Host service unavailable" }
        guard status.isFresh() else { return "Host service is not reporting" }
        switch status.connectionStatus {
        case .connected: return "Connected to relay"
        case .disconnected: return "Relay disconnected"
        case .revoked: return "Machine credentials revoked"
        case .stopped: return "Host service stopped"
        }
    }

    @discardableResult
    private func add(_ title: String, action: Selector? = nil, enabled: Bool = true, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        item.isEnabled = action != nil && enabled
        menu.addItem(item)
        return item
    }

    private func rebuildMenu() {
        // Updating the native menu preserves keyboard navigation and VoiceOver behavior.
        menu.removeAllItems()
        let title = add(status?.name ?? "Actions Fleet")
        title.attributedTitle = NSAttributedString(string: title.title, attributes: [.font: NSFont.boldSystemFont(ofSize: 13)])
        let connection = add(connectionDescription)
        let color: NSColor = status?.isFresh() != true ? .secondaryLabelColor
            : status?.connectionStatus == .connected ? .systemGreen
            : status?.connectionStatus == .revoked ? .systemRed : .systemOrange
        connection.attributedTitle = NSAttributedString(string: "●  \(connectionDescription)", attributes: [.foregroundColor: color, .font: NSFont.systemFont(ofSize: 12)])
        if let status {
            add("Build mode: \(status.effectiveMode.rawValue.capitalized)")
            if status.localModeOverride == .paused { add("Locally paused · dashboard mode is \(status.mode.rawValue.capitalized)") }
            if !status.isFresh(), let date = status.updateDate {
                add("Last report: \(date.formatted(date: .abbreviated, time: .shortened))")
            }
        } else if let readError { add(readError) }
        menu.addItem(.separator())

        if let job = status?.currentJob {
            add(status?.isFresh() == true ? "Running job" : "Last reported job")
            let repository = add(job.repository)
            repository.toolTip = job.repository
            add("Run #\(job.runId) · attempt \(job.runAttempt)")
            add("Open job in GitHub…", action: #selector(openJob), enabled: job.githubURL != nil)
            add("View live logs…", action: #selector(openJobDashboard), enabled: preferences.dashboard != nil)
        } else { add(status?.isFresh() == true ? "No active jobs" : "No current job information") }

        if let metrics = status?.metrics, status?.isFresh() == true {
            let used = metrics.memoryUsedBytes / 1_073_741_824
            let total = metrics.memoryTotalBytes / 1_073_741_824
            add(String(format: "CPU %.0f%% · memory %.1f / %.1f GB", metrics.cpuPercent, used, total))
        }
        if let error = status?.error, !error.isEmpty { add(String(error.prefix(150))) }
        else if let reason = status?.admissionReason, !reason.isEmpty { add(String(reason.prefix(150))) }
        menu.addItem(.separator())

        let canControl = status?.isFresh() == true && status?.connectionStatus != .stopped && status?.connectionStatus != .revoked
        if let requestedPause { add(requestedPause ? "Pausing admission…" : "Resuming local admission…") }
        else if status?.localModeOverride == .paused {
            add("Resume local admission", action: #selector(resume), enabled: canControl)
        } else {
            add("Pause new jobs on this Mac", action: #selector(pause), enabled: canControl)
        }
        add("Manage machine modes…", action: #selector(openMachines), enabled: preferences.dashboard != nil)
        add("Open dashboard…", action: #selector(openDashboard), enabled: preferences.dashboard != nil, key: "o")
        menu.addItem(.separator())
        add("Settings…", action: #selector(configure), key: ",")
        add("Refresh status", action: #selector(refresh), key: "r")
        menu.addItem(.separator())
        add("Build service keeps running when this app quits.")
        add("Quit menu bar app", action: #selector(quit), key: "q")
    }

    @objc private func openDashboard() { if let url = preferences.dashboard { NSWorkspace.shared.open(url) } }
    @objc private func openMachines() { openDashboardPage("hosts") }
    @objc private func openJobDashboard() { openDashboardPage("runs", jobID: status?.currentJob?.id) }
    @objc private func openJob() { if let url = status?.currentJob?.githubURL { NSWorkspace.shared.open(url) } }

    private func openDashboardPage(_ page: String, jobID: String? = nil) {
        guard let base = preferences.dashboard, var url = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return }
        var query = (url.queryItems ?? []).filter { !["view", "job"].contains($0.name) }
        query.append(URLQueryItem(name: "view", value: page))
        if let jobID { query.append(URLQueryItem(name: "job", value: jobID)) }
        url.queryItems = query
        if let destination = url.url { NSWorkspace.shared.open(destination) }
    }

    @objc private func pause() { setLocalPause(true) }
    @objc private func resume() { setLocalPause(false) }

    private func setLocalPause(_ paused: Bool) {
        guard status?.isFresh() == true else { return }
        do {
            // This is the agent's documented nonsecret local control contract. No
            // token, shell command, PID signal, or dashboard credential is used.
            let target = preferences.stateURL.appendingPathComponent("control.json")
            let data = try JSONSerialization.data(withJSONObject: ["paused": paused], options: [.sortedKeys])
            try data.write(to: target, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
            requestedPause = paused
            rebuildMenu()
        } catch { showError("Could not update local admission", detail: error.localizedDescription) }
    }

    @objc private func configure() {
        let alert = NSAlert()
        alert.messageText = "Actions Fleet settings"
        alert.informativeText = "Choose the host service’s state directory and the dashboard URL. No credentials are stored in this app."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 390, height: 112))
        let directoryLabel = NSTextField(labelWithString: "Agent state directory")
        directoryLabel.frame = NSRect(x: 0, y: 92, width: 390, height: 18)
        let directoryField = NSTextField(string: preferences.stateDirectory)
        directoryField.frame = NSRect(x: 0, y: 63, width: 390, height: 25)
        directoryField.setAccessibilityLabel("Agent state directory")
        let dashboardLabel = NSTextField(labelWithString: "Dashboard URL")
        dashboardLabel.frame = NSRect(x: 0, y: 33, width: 390, height: 18)
        let dashboardField = NSTextField(string: preferences.dashboardURL)
        dashboardField.placeholderString = "https://your-fleet.vercel.app"
        dashboardField.frame = NSRect(x: 0, y: 4, width: 390, height: 25)
        dashboardField.setAccessibilityLabel("Dashboard URL")
        [directoryLabel, directoryField, dashboardLabel, dashboardField].forEach(container.addSubview)
        alert.accessoryView = container
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let next = Preferences(stateDirectory: directoryField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines), dashboardURL: dashboardField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines))
        guard (next.stateDirectory as NSString).expandingTildeInPath.hasPrefix("/"), !next.stateDirectory.isEmpty else {
            showError("Choose an absolute state directory", detail: "Use the directory configured for the host service.")
            return
        }
        guard next.dashboardURL.isEmpty || next.dashboard != nil else {
            showError("Enter a valid dashboard URL", detail: "Use HTTPS, or HTTP for a localhost development dashboard.")
            return
        }
        do {
            try FileManager.default.createDirectory(at: preferencesURL.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try JSONEncoder().encode(next).write(to: preferencesURL, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: preferencesURL.path)
            preferences = next
            requestedPause = nil
            refresh()
        } catch { showError("Could not save settings", detail: error.localizedDescription) }
    }

    private func showError(_ message: String, detail: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = detail
        alert.alertStyle = .warning
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    @objc private func quit() { timer?.invalidate(); NSApp.terminate(nil) }
}
