@preconcurrency import LiveKit
import Foundation
import AVFoundation
import CallKit
import Combine

@MainActor
final class LiveKitService: NSObject, ObservableObject {
    let room = Room()
    private let callController = CXCallController()
    private let provider: CXProvider = {
        let config = CXProviderConfiguration()
        config.supportsVideo = false
        config.supportedHandleTypes = [.generic]
        config.maximumCallsPerCallGroup = 1
        return CXProvider(configuration: config)
    }()
    private var callUUID: UUID?
    private let thinkingSound = ThinkingSound()

    @Published var connectionState: ConnectionState = .disconnected
    @Published var isMuted = false
    @Published var isHeld = false
    @Published var status: AssistantStatus = .disconnected
    @Published var transcriptText = "Tap Connect to start"
    @Published var llmLatency: String?

    var sessionId: String?
    private var pendingResume: String?
    private var pendingProject: String?
    private var userFinal = ""

    override init() {
        super.init()
        room.add(delegate: self)
        provider.setDelegate(self, queue: .main)

        // AVAudioApplication notification as backup for non-CallKit mute changes
        NotificationCenter.default.addObserver(
            forName: AVAudioApplication.inputMuteStateChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self else { return }
            let systemMuted = (notification.userInfo?[AVAudioApplication.muteStateKey] as? NSNumber)?.boolValue
                ?? AVAudioApplication.shared.isInputMuted
            Task { @MainActor in
                if self.isMuted != systemMuted {
                    self.isMuted = systemMuted
                    try? await self.room.localParticipant.setMicrophone(enabled: !systemMuted)
                }
            }
        }
    }

    // MARK: - Connection

    func connect(project: String, resumeSessionId: String?) async {
        guard connectionState == .disconnected else { return }
        connectionState = .connecting
        pendingResume = resumeSessionId ?? "__new__"
        pendingProject = project

        do {
            // Force voiceChat mode (not videoChat) — required for AirPods mute gesture
            // LiveKit uses isSpeakerOutputPreferred to choose: true=videoChat, false=voiceChat
            AudioManager.shared.isSpeakerOutputPreferred = false
            // Opt in to system mute mechanism
            try AVAudioApplication.shared.setInputMuted(false)

            let token = try await fetchToken()
            try await room.connect(
                url: Config.livekitURL,
                token: token,
                connectOptions: ConnectOptions(enableMicrophone: true)
            )
            connectionState = .connected
            isMuted = false
            isHeld = false
            status = .listening
            transcriptText = "Listening..."

            // Report "call" to iOS via CallKit — enables AirPods mute gesture
            let uuid = UUID()
            callUUID = uuid
            let handle = CXHandle(type: .generic, value: "Voice Assistant")
            let startAction = CXStartCallAction(call: uuid, handle: handle)
            startAction.isVideo = false
            let transaction = CXTransaction(action: startAction)
            try? await callController.request(transaction)
            // Mark as connected so iOS shows "in call" state
            provider.reportOutgoingCall(with: uuid, connectedAt: Date())
        } catch {
            print("[LiveKit] Connect error: \(error)")
            connectionState = .disconnected
            status = .disconnected
            transcriptText = "Connection failed"
        }
    }

    func disconnect() async {
        thinkingSound.stop()
        // End CallKit call
        if let uuid = callUUID {
            let endAction = CXEndCallAction(call: uuid)
            let transaction = CXTransaction(action: endAction)
            try? await callController.request(transaction)
            callUUID = nil

        }
        await room.disconnect()
        connectionState = .disconnected
        status = .disconnected
        isMuted = false
        isHeld = false
        transcriptText = "Tap Connect to start"
        llmLatency = nil
        userFinal = ""
    }

    // MARK: - Mute

    func toggleMute() async {
        isMuted.toggle()
        do {
            try await room.localParticipant.setMicrophone(enabled: !isMuted)
        } catch {
            print("[LiveKit] Mute toggle error: \(error)")
            isMuted.toggle() // revert
        }
    }

    // MARK: - Hold

    func toggleHold() async {
        isHeld.toggle()
        let msg = DataMessage(type: isHeld ? "hold_llm" : "release_llm",
                              sessionId: nil, projectName: nil, llmDuration: nil, held: nil)
        await publishMessage(msg)
    }

    // MARK: - Data

    private func publishMessage(_ msg: DataMessage) async {
        guard let data = try? JSONEncoder().encode(msg) else { return }
        do {
            try await room.localParticipant.publish(
                data: data,
                options: DataPublishOptions(reliable: true)
            )
        } catch {
            print("[LiveKit] Publish error: \(error)")
        }
    }

    func sendSessionInit(sessionId: String?, projectName: String) async {
        var fields: [String: Any] = ["type": "session_init", "projectName": projectName]
        if let sid = sessionId, sid != "__new__" {
            fields["sessionId"] = sid
        }
        guard let data = try? JSONSerialization.data(withJSONObject: fields) else { return }
        do {
            try await room.localParticipant.publish(
                data: data,
                options: DataPublishOptions(reliable: true)
            )
        } catch {
            print("[LiveKit] session_init publish error: \(error)")
        }
    }

    // MARK: - Token

    private func fetchToken() async throws -> String {
        let room = "voice-\(Int(Date().timeIntervalSince1970 * 1000))"
        let identity = "user-ios"
        guard let url = URL(string: "\(Config.serverURL)/api/token?room=\(room)&identity=\(identity)") else {
            throw URLError(.badURL)
        }
        let (data, _) = try await URLSession.shared.data(from: url)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let token = json?["token"] as? String else {
            throw URLError(.cannotParseResponse)
        }
        return token
    }
}

// MARK: - RoomDelegate

extension LiveKitService: RoomDelegate {
    nonisolated func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        Task { @MainActor in
            self.connectionState = .disconnected
            self.status = .disconnected
            self.isMuted = false
            self.isHeld = false
            self.thinkingSound.stop()
            self.transcriptText = "Tap Connect to start"
            self.llmLatency = nil
        }
    }

    nonisolated func room(_ room: Room, participant: RemoteParticipant?, didReceiveData data: Data, forTopic topic: String, encryptionType: EncryptionType) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        Task { @MainActor in
            switch type {
            case "thinking":
                self.userFinal = ""
                self.status = .thinking
                self.transcriptText = ""
                self.thinkingSound.start()

            case "tool_call", "tool_use":
                self.status = .thinking
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    if self.status == .thinking {
                        self.thinkingSound.start()
                    }
                }

            case "metrics":
                if let duration = json["llmDuration"] as? Double {
                    self.llmLatency = String(format: "LLM %.1fs", duration / 1000)
                }

            case "session_info":
                if self.pendingResume != nil {
                    let rid = self.pendingResume
                    self.pendingResume = nil
                    await self.sendSessionInit(
                        sessionId: rid == "__new__" ? nil : rid,
                        projectName: self.pendingProject ?? "_global"
                    )
                    return
                }
                self.sessionId = json["sessionId"] as? String

            case "context_switched":
                self.sessionId = json["sessionId"] as? String

            default:
                break
            }
        }
    }

    nonisolated func room(_ room: Room, participant: Participant, trackPublication: TrackPublication, didReceiveTranscriptionSegments segments: [TranscriptionSegment]) {
        let isAgent = participant.identity?.stringValue.hasPrefix("agent") ?? false

        Task { @MainActor in
            for seg in segments {
                if isAgent {
                    self.thinkingSound.stop()
                    self.status = .speaking
                    self.transcriptText = seg.text
                } else {
                    self.thinkingSound.stop()
                    if seg.isFinal {
                        self.userFinal += (self.userFinal.isEmpty ? "" : " ") + seg.text
                        self.transcriptText = self.userFinal
                    } else {
                        self.transcriptText = self.userFinal.isEmpty ? seg.text : self.userFinal + " " + seg.text
                    }
                    self.status = .listening
                }
            }
        }
    }
}

// MARK: - CXProviderDelegate (CallKit — enables AirPods mute gesture)

extension LiveKitService: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {}

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        Task { @MainActor in
            self.isMuted = action.isMuted
            try? await self.room.localParticipant.setMicrophone(enabled: !action.isMuted)
        }
        action.fulfill()
    }
}
