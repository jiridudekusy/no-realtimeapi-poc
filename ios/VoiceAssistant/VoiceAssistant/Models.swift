import Foundation

struct Project: Identifiable, Codable {
    var id: String { name }
    let name: String
    let displayName: String?
    let description: String?
}

enum ConnectionState: String {
    case disconnected, connecting, connected
}

enum AssistantStatus: String {
    case disconnected, listening, thinking, speaking
}

struct DataMessage: Codable {
    let type: String
    let sessionId: String?
    let projectName: String?
    let llmDuration: Double?
    let held: Bool?

    enum CodingKeys: String, CodingKey {
        case type, sessionId, projectName, llmDuration, held
    }
}
