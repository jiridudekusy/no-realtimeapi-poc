import Foundation

enum Config {
    private static let defaults = UserDefaults.standard

    static let defaultServerURL = "https://jdk-neo.taila4682.ts.net"
    static let defaultLiveKitURL = "wss://jdk-neo.taila4682.ts.net:7880"

    static var serverURL: String {
        get { defaults.string(forKey: "serverURL") ?? defaultServerURL }
        set { defaults.set(newValue, forKey: "serverURL") }
    }

    static var livekitURL: String {
        get { defaults.string(forKey: "livekitURL") ?? defaultLiveKitURL }
        set { defaults.set(newValue, forKey: "livekitURL") }
    }
}
