import Foundation

enum HostMode: String, Codable { case dedicated, shared, paused }
enum ConnectionStatus: String, Codable { case connected, disconnected, revoked, stopped }

struct CurrentJob: Codable {
    let id: String
    let runId: Int64
    let runAttempt: Int
    let repository: String
    let htmlUrl: String

    var githubURL: URL? {
        guard let url = URL(string: htmlUrl), url.scheme == "https", url.host == "github.com",
              url.user == nil, url.password == nil else { return nil }
        return url
    }
}

struct HostMetrics: Codable {
    let cpuPercent: Double
    let memoryUsedBytes: Double
    let memoryTotalBytes: Double
    let diskFreeBytes: Double
    let cpuCount: Int
}

struct PublicStatus: Codable {
    let schemaVersion: Int
    let hostId: String
    let name: String
    let connectionStatus: ConnectionStatus
    let mode: HostMode
    let localModeOverride: HostMode?
    let effectiveMode: HostMode
    let currentJob: CurrentJob?
    let metrics: HostMetrics?
    let updatedAt: String
    let error: String?
    let admissionReason: String?

    var updateDate: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: updatedAt) ?? ISO8601DateFormatter().date(from: updatedAt)
    }

    func isFresh(at now: Date = Date()) -> Bool {
        guard let date = updateDate else { return false }
        let age = now.timeIntervalSince(date)
        return age >= -10 && age < 30
    }

    static func decode(_ data: Data) throws -> PublicStatus {
        let status = try JSONDecoder().decode(PublicStatus.self, from: data)
        guard status.schemaVersion == 1 else { throw StatusError.unsupportedVersion }
        return status
    }
}

enum StatusError: Error { case unsupportedVersion }

struct Preferences: Codable {
    var stateDirectory: String
    var dashboardURL: String

    static var defaultStateDirectory: String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Actions Fleet", isDirectory: true).path
    }

    static var defaults: Preferences { Preferences(stateDirectory: defaultStateDirectory, dashboardURL: "") }

    var dashboard: URL? {
        guard let url = URL(string: dashboardURL), let host = url.host,
              url.user == nil, url.password == nil,
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)) else { return nil }
        return url
    }

    var stateURL: URL {
        URL(fileURLWithPath: (stateDirectory as NSString).expandingTildeInPath, isDirectory: true)
    }
}
