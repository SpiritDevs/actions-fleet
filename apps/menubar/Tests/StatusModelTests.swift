import Foundation

@main
struct StatusModelTests {
    static func main() throws {
        let data = Data("""
        {"schemaVersion":1,"hostId":"host-1","name":"Studio Mac","connectionStatus":"connected","mode":"shared","localModeOverride":"paused","effectiveMode":"paused","currentJob":{"id":"job-1","runId":123456789012,"runAttempt":2,"repository":"SpiritDevs/pathway","htmlUrl":"https://github.com/SpiritDevs/pathway/actions/runs/123456789012"},"updatedAt":"2026-09-19T00:00:00.000Z"}
        """.utf8)
        let status = try PublicStatus.decode(data)
        let now = ISO8601DateFormatter().date(from: "2026-09-19T00:00:10Z")!
        assert(status.isFresh(at: now))
        assert(!status.isFresh(at: now.addingTimeInterval(40)))
        assert(!status.isFresh(at: now.addingTimeInterval(-60)))
        assert(status.localModeOverride == .paused && status.mode == .shared)
        assert(status.currentJob?.runId == 123456789012)
        assert(status.currentJob?.githubURL?.host == "github.com")
        let maliciousJob = CurrentJob(id: "1", runId: 1, runAttempt: 1, repository: "test/repo", htmlUrl: "https://github.com.attacker.test/run")
        assert(maliciousJob.githubURL == nil)
        assert(Preferences(stateDirectory: "/tmp", dashboardURL: "javascript:alert(1)").dashboard == nil)
        assert(Preferences(stateDirectory: "/tmp", dashboardURL: "http://example.com").dashboard == nil)
        assert(Preferences(stateDirectory: "/tmp", dashboardURL: "https://secret@example.com").dashboard == nil)
        assert(Preferences(stateDirectory: "/tmp", dashboardURL: "http://127.0.0.1:5173").dashboard != nil)
        assert(Preferences(stateDirectory: "/tmp", dashboardURL: "https://fleet.example.com").dashboard != nil)
        let unsupported = Data(String(decoding: data, as: UTF8.self).replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":99").utf8)
        do { _ = try PublicStatus.decode(unsupported); fatalError("Unsupported schema was accepted") }
        catch StatusError.unsupportedVersion {}
        print("Menu bar model checks passed: status freshness, local mode, job identity, URL validation, schema version.")
    }
}
