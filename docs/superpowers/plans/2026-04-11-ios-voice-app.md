# iOS Voice Assistant App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal native iOS app (equivalent to mobile.html) that connects to the existing LiveKit server with AirPods hardware mute support.

**Architecture:** Single-screen SwiftUI app using LiveKit Swift SDK. LiveKitService (ObservableObject) manages Room connection, mute state, transcripts, and data messages. ProjectService fetches projects from the token server API. ThinkingSound generates "Ocean Sweep" audio via AVAudioEngine. No tests — this is a UI-only POC sideloaded via Xcode.

**Tech Stack:** SwiftUI, LiveKit Swift SDK (SPM), AVAudioEngine, AVAudioSession

**Spec:** `docs/superpowers/specs/2026-04-11-ios-voice-app-design.md`

---

## File Structure

```
ios/
  VoiceAssistant/
    VoiceApp.swift            — App entry point
    Config.swift              — Server URL constant
    Models.swift              — Shared data types (Project, DataMessage)
    Services/
      LiveKitService.swift    — Room connection, mute, transcript, data handling
      ProjectService.swift    — HTTP: list projects
      ThinkingSound.swift     — AVAudioEngine "Ocean Sweep" generator
    Views/
      ContentView.swift       — Main screen layout
      ProjectSheet.swift      — Project picker sheet
      ThinkingDotsView.swift  — Pulsing dots animation
```

The Xcode project itself will be created via `xcodebuild` / Xcode GUI — the plan covers source files only.

---

### Task 1: Create Xcode project and add LiveKit SDK

**Files:**
- Create: `ios/` directory with Xcode project
- Create: `ios/VoiceAssistant/VoiceApp.swift`
- Create: `ios/VoiceAssistant/Config.swift`

- [ ] **Step 1: Create the Xcode project**

Open Xcode → File → New → Project → App:
- Product Name: `VoiceAssistant`
- Team: (your personal team)
- Organization Identifier: e.g. `com.yourname`
- Interface: SwiftUI
- Language: Swift
- Save location: `ios/` directory inside `realtimeApi/`

This creates `ios/VoiceAssistant.xcodeproj` and `ios/VoiceAssistant/` with default files.

- [ ] **Step 2: Add LiveKit Swift SDK via SPM**

In Xcode: File → Add Package Dependencies → Enter URL:
```
https://github.com/livekit/client-sdk-swift
```
Version: Up to Next Major from `2.5.0`
Add `LiveKit` library to the VoiceAssistant target.

- [ ] **Step 3: Configure project settings**

In Xcode project settings:
- Set minimum deployment target: **iOS 17.0**
- Add capability: **Background Modes** → check **Audio, AirPlay, and Picture in Picture**
- Add to Info.plist: `NSMicrophoneUsageDescription` = "Voice assistant needs microphone access"
- Set supported orientations: Portrait only

- [ ] **Step 4: Write Config.swift**

Replace any generated ContentView with this. Create `Config.swift`:

```swift
import Foundation

enum Config {
    // Change this to your server URL (Tailscale HTTPS or local)
    static let serverURL = "https://your-machine.tail12345.ts.net:3001"
    static let livekitURL = "wss://your-machine.tail12345.ts.net:7880"
}
```

- [ ] **Step 5: Write minimal VoiceApp.swift**

Replace the generated app file:

```swift
import SwiftUI

@main
struct VoiceApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(nil) // follow system
        }
    }
}
```

- [ ] **Step 6: Build to verify SPM resolves**

Build the project (Cmd+B). SPM should download LiveKit SDK. Expect: Build Succeeded (with default ContentView placeholder).

- [ ] **Step 7: Commit**

```bash
cd ios && git add -A && git commit -m "feat(ios): scaffold Xcode project with LiveKit SDK"
```

---

### Task 2: Models and ThinkingSound

**Files:**
- Create: `ios/VoiceAssistant/Models.swift`
- Create: `ios/VoiceAssistant/Services/ThinkingSound.swift`

- [ ] **Step 1: Write Models.swift**

```swift
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
```

- [ ] **Step 2: Write ThinkingSound.swift**

Port of web "Ocean Sweep" — bandpass-filtered noise sweep 200→1200 Hz:

```swift
import AVFoundation

final class ThinkingSound {
    private var engine: AVAudioEngine?
    private var playerNode: AVAudioPlayerNode?
    private var timer: Timer?
    private var isPlaying = false

    func start() {
        guard !isPlaying else { return }
        isPlaying = true
        playPulse()
        timer = Timer.scheduledTimer(withTimeInterval: 3.5, repeats: true) { [weak self] _ in
            self?.playPulse()
        }
    }

    func stop() {
        isPlaying = false
        timer?.invalidate()
        timer = nil
        engine?.stop()
        engine = nil
        playerNode = nil
    }

    private func playPulse() {
        guard isPlaying else { return }

        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        let sampleRate: Double = 44100
        let duration: Double = 2.5
        let frameCount = AVAudioFrameCount(sampleRate * duration)

        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return }

        buffer.frameLength = frameCount
        guard let channelData = buffer.floatChannelData?[0] else { return }

        // Fill with white noise
        for i in 0..<Int(frameCount) {
            channelData[i] = Float.random(in: -1...1)
        }

        // Bandpass filter: sweep 200→1200→200 Hz
        let eq = AVAudioUnitEQ(numberOfBands: 1)
        let band = eq.bands[0]
        band.filterType = .bandPass
        band.frequency = 200
        band.bandwidth = 1.0
        band.bypass = false

        // Gain envelope
        let mixer = engine.mainMixerNode
        engine.attach(player)
        engine.attach(eq)
        engine.connect(player, to: eq, format: format)
        engine.connect(eq, to: mixer, format: format)
        mixer.outputVolume = 0.025

        do {
            try engine.start()
            player.play()
            player.scheduleBuffer(buffer, completionHandler: nil)

            // Sweep frequency over duration
            let steps = 50
            let halfDuration = duration / 2
            for step in 0...steps {
                let t = Double(step) / Double(steps)
                let freq: Float
                if t < 0.5 {
                    freq = 200 + Float(t * 2) * 1000 // 200→1200
                } else {
                    freq = 1200 - Float((t - 0.5) * 2) * 1000 // 1200→200
                }
                let delay = t * duration
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    band.frequency = freq
                }
            }

            // Stop after duration
            DispatchQueue.main.asyncAfter(deadline: .now() + duration) { [weak self] in
                player.stop()
                engine.stop()
                if self?.engine === engine {
                    self?.engine = nil
                    self?.playerNode = nil
                }
            }
        } catch {
            print("[ThinkingSound] Engine start failed: \(error)")
        }

        self.engine = engine
        self.playerNode = player
    }
}
```

- [ ] **Step 3: Build to verify**

Build (Cmd+B). Expect: Build Succeeded.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(ios): add data models and thinking sound generator"
```

---

### Task 3: ProjectService

**Files:**
- Create: `ios/VoiceAssistant/Services/ProjectService.swift`

- [ ] **Step 1: Write ProjectService.swift**

```swift
import Foundation

@MainActor
final class ProjectService: ObservableObject {
    @Published var projects: [Project] = []
    @Published var currentProject: Project = Project(name: "_global", displayName: "Home", description: nil)
    @Published var isLoading = false

    func loadProjects() async {
        isLoading = true
        defer { isLoading = false }

        guard let url = URL(string: "\(Config.serverURL)/api/projects") else { return }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let decoded = try JSONDecoder().decode([Project].self, from: data)
            projects = decoded
        } catch {
            print("[ProjectService] Failed to load projects: \(error)")
        }
    }

    func selectProject(_ project: Project) {
        currentProject = project
    }

    func selectGlobal() {
        currentProject = Project(name: "_global", displayName: "Home", description: nil)
    }

    var displayName: String {
        if currentProject.name == "_global" { return "Home" }
        return currentProject.displayName ?? currentProject.name
    }
}
```

- [ ] **Step 2: Build to verify**

Build (Cmd+B). Expect: Build Succeeded.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(ios): add ProjectService for API project listing"
```

---

### Task 4: LiveKitService

**Files:**
- Create: `ios/VoiceAssistant/Services/LiveKitService.swift`

- [ ] **Step 1: Write LiveKitService.swift**

This is the core — manages Room, connection, mute, transcript, data messages.

```swift
@preconcurrency import LiveKit
import Foundation
import AVFoundation
import Combine

@MainActor
final class LiveKitService: ObservableObject {
    let room = Room()
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

    init() {
        room.add(delegate: self)
    }

    // MARK: - Connection

    func connect(project: String, resumeSessionId: String?) async {
        guard connectionState == .disconnected else { return }
        connectionState = .connecting
        pendingResume = resumeSessionId ?? "__new__"
        pendingProject = project

        do {
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
        } catch {
            print("[LiveKit] Connect error: \(error)")
            connectionState = .disconnected
            status = .disconnected
            transcriptText = "Connection failed"
        }
    }

    func disconnect() async {
        thinkingSound.stop()
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
    nonisolated func room(_ room: Room, didDisconnectWithError error: (any Error)?) {
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

    nonisolated func room(_ room: Room, participant: RemoteParticipant?, didReceiveData data: Data, forTopic topic: String) {
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
                // Sound with slight delay for tool calls
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
                // projectName handled by ContentView observing this

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
```

- [ ] **Step 2: Build to verify**

Build (Cmd+B). Expect: Build Succeeded. There may be warnings about `nonisolated` — those are OK.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(ios): add LiveKitService with Room, mute, transcript, data handling"
```

---

### Task 5: ThinkingDotsView and ProjectSheet

**Files:**
- Create: `ios/VoiceAssistant/Views/ThinkingDotsView.swift`
- Create: `ios/VoiceAssistant/Views/ProjectSheet.swift`

- [ ] **Step 1: Write ThinkingDotsView.swift**

```swift
import SwiftUI

struct ThinkingDotsView: View {
    @State private var animating = false

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Color.orange)
                    .frame(width: 7, height: 7)
                    .scaleEffect(animating ? 1.1 : 0.8)
                    .opacity(animating ? 1.0 : 0.25)
                    .animation(
                        .easeInOut(duration: 0.7)
                        .repeatForever(autoreverses: true)
                        .delay(Double(index) * 0.2),
                        value: animating
                    )
            }
        }
        .frame(height: 28)
        .onAppear { animating = true }
    }
}
```

- [ ] **Step 2: Write ProjectSheet.swift**

```swift
import SwiftUI

struct ProjectSheet: View {
    @ObservedObject var projectService: ProjectService
    @Environment(\.dismiss) private var dismiss
    let onSelect: (Project?) -> Void

    var body: some View {
        NavigationStack {
            List {
                // Home (_global)
                Button {
                    onSelect(nil)
                    dismiss()
                } label: {
                    HStack {
                        Text("Home")
                        Spacer()
                        if projectService.currentProject.name == "_global" {
                            Image(systemName: "checkmark")
                                .foregroundStyle(.blue)
                        }
                    }
                }

                // Projects
                ForEach(projectService.projects) { project in
                    Button {
                        onSelect(project)
                        dismiss()
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(project.displayName ?? project.name)
                                Spacer()
                                if projectService.currentProject.name == project.name {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(.blue)
                                }
                            }
                            if let desc = project.description, !desc.isEmpty {
                                Text(desc)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Projects")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .task {
            await projectService.loadProjects()
        }
    }
}
```

- [ ] **Step 3: Build to verify**

Build (Cmd+B). Expect: Build Succeeded.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(ios): add ThinkingDotsView and ProjectSheet"
```

---

### Task 6: ContentView — main screen

**Files:**
- Create: `ios/VoiceAssistant/Views/ContentView.swift`

- [ ] **Step 1: Write ContentView.swift**

```swift
import SwiftUI

struct ContentView: View {
    @StateObject private var lk = LiveKitService()
    @StateObject private var projects = ProjectService()
    @State private var showProjectSheet = false

    var body: some View {
        VStack(spacing: 0) {
            // Project bar
            projectBar

            // Transcript area
            transcriptArea
                .padding(.top, 8)

            // Controls
            controlButtons
                .padding(.top, 14)

            // Metrics
            metricsBar

            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background(Color(.systemBackground))
        .sheet(isPresented: $showProjectSheet) {
            ProjectSheet(projectService: projects) { project in
                handleProjectSelect(project)
            }
            .presentationDetents([.medium])
        }
    }

    // MARK: - Project Bar

    private var projectBar: some View {
        Button {
            showProjectSheet = true
        } label: {
            Text(projectBarText)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
        }
    }

    private var projectBarText: String {
        let name = projects.displayName
        let icon = projects.currentProject.name == "_global" ? "\u{1F3E0}" : "\u{1F4C1}"
        return "\(icon) \(name) \u{25BE}"
    }

    // MARK: - Transcript Area

    private var transcriptArea: some View {
        VStack(spacing: 8) {
            Text(lk.status.rawValue.uppercased())
                .font(.system(size: 11, weight: .semibold))
                .tracking(1)
                .foregroundStyle(statusColor)

            if lk.status == .thinking {
                ThinkingDotsView()
            } else {
                Text(lk.transcriptText)
                    .font(.system(size: 18))
                    .lineLimit(4)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.primary)
                    .frame(minHeight: 28)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
        .padding(.vertical, 20)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private var statusColor: Color {
        switch lk.status {
        case .disconnected: return .secondary
        case .listening: return Color(red: 0.49, green: 0.51, blue: 1.0)
        case .thinking: return .orange
        case .speaking: return .green
        }
    }

    // MARK: - Controls

    private var controlButtons: some View {
        VStack(spacing: 10) {
            // Mute button
            Button {
                Task { await lk.toggleMute() }
            } label: {
                Label(
                    lk.isMuted ? "Muted" : "Mute",
                    systemImage: lk.isMuted ? "mic.slash.fill" : "mic.fill"
                )
                .frame(maxWidth: .infinity)
                .padding(16)
                .background(lk.isMuted ? Color.red.opacity(0.15) : Color(.tertiarySystemFill))
                .foregroundStyle(lk.isMuted ? .red : .primary)
                .clipShape(RoundedRectangle(cornerRadius: 14))
            }
            .disabled(lk.connectionState != .connected)
            .opacity(lk.connectionState != .connected ? 0.35 : 1)

            // Hold button
            Button {
                Task { await lk.toggleHold() }
            } label: {
                Label(
                    lk.isHeld ? "LLM: Hold" : "LLM: Auto",
                    systemImage: "brain"
                )
                .frame(maxWidth: .infinity)
                .padding(16)
                .background(lk.isHeld ? Color.orange.opacity(0.15) : Color(.tertiarySystemFill))
                .foregroundStyle(lk.isHeld ? .orange : .primary)
                .clipShape(RoundedRectangle(cornerRadius: 14))
            }
            .disabled(lk.connectionState != .connected)
            .opacity(lk.connectionState != .connected ? 0.35 : 1)

            // Connect/Disconnect button
            Button {
                Task { await handleConnect() }
            } label: {
                Text(connectButtonText)
                    .font(.system(size: 18, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(18)
                    .background(connectButtonColor)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            }
        }
    }

    private var connectButtonText: String {
        switch lk.connectionState {
        case .disconnected: return "Connect"
        case .connecting: return "Connecting..."
        case .connected: return "Disconnect"
        }
    }

    private var connectButtonColor: Color {
        lk.connectionState == .connected ? .red : .green
    }

    // MARK: - Metrics

    private var metricsBar: some View {
        Text(lk.llmLatency ?? "")
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .frame(minHeight: 24)
    }

    // MARK: - Actions

    private func handleConnect() async {
        if lk.connectionState == .connected {
            await lk.disconnect()
        } else {
            await lk.connect(
                project: projects.currentProject.name,
                resumeSessionId: lk.sessionId
            )
        }
    }

    private func handleProjectSelect(_ project: Project?) {
        let prev = projects.currentProject.name
        if let project {
            projects.selectProject(project)
        } else {
            projects.selectGlobal()
        }
        let next = projects.currentProject.name
        if next != prev {
            lk.sessionId = nil
            if lk.connectionState == .connected {
                Task { await lk.disconnect() }
            }
        }
    }
}
```

- [ ] **Step 2: Build to verify**

Build (Cmd+B). Expect: Build Succeeded.

- [ ] **Step 3: Run on simulator**

Run on iPhone simulator (Cmd+R). App should launch with dark/light UI, "Tap Connect to start", project bar showing "Home". Connect will fail (no server) but UI should render.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(ios): add ContentView — main screen with all controls"
```

---

### Task 7: AirPods mute observation

**Files:**
- Modify: `ios/VoiceAssistant/Services/LiveKitService.swift`

- [ ] **Step 1: Add AVAudioSession mute observation to LiveKitService**

Add this to LiveKitService's `init()` method, after `room.add(delegate: self)`:

```swift
// Observe AirPods mute gesture
NotificationCenter.default.addObserver(
    forName: AVAudioSession.muteStateDidChangeNotification,
    object: nil,
    queue: .main
) { [weak self] _ in
    guard let self else { return }
    Task { @MainActor in
        let session = AVAudioSession.sharedInstance()
        let systemMuted = session.isMicrophoneMuted
        if self.isMuted != systemMuted {
            self.isMuted = systemMuted
            // Sync LiveKit track state with system mute
            try? await self.room.localParticipant.setMicrophone(enabled: !systemMuted)
        }
    }
}
```

Note: `AVAudioSession.muteStateDidChangeNotification` and `isMicrophoneMuted` require iOS 17.0+, which we already set as our minimum target.

- [ ] **Step 2: Build to verify**

Build (Cmd+B). Expect: Build Succeeded.

- [ ] **Step 3: Test on physical device with AirPods**

Connect AirPods Pro to iPhone. Run app on device. Connect to voice. Squeeze AirPods stem → should mute mic and update UI. Squeeze again → unmute.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(ios): add AirPods mute gesture observation via AVAudioSession"
```

---

### Task 8: End-to-end test on device

This is a manual verification task — no code changes.

- [ ] **Step 1: Ensure server is running**

```bash
docker compose up -d
```

Verify token server is accessible from phone (via Tailscale or local network).

- [ ] **Step 2: Update Config.swift with correct URLs**

Set `Config.serverURL` and `Config.livekitURL` to your actual Tailscale URLs.

- [ ] **Step 3: Run on physical iPhone**

Connect iPhone via cable. Select it as run destination in Xcode. Run (Cmd+R). Trust the developer on iPhone if prompted (Settings → General → VPN & Device Management).

- [ ] **Step 4: Test full flow**

1. App launches, shows "Home" project bar, "Tap Connect to start"
2. Tap Connect → mic permission prompt → "Listening..."
3. Speak → transcript appears → thinking dots + sound → agent response
4. Tap Mute → button turns red, mic off
5. Tap Mute again → unmute
6. **AirPods squeeze → mute/unmute** (the main goal!)
7. Tap project bar → sheet with projects
8. Select different project → disconnect + reconnect
9. Tap Disconnect → back to initial state
10. Test light mode: switch system appearance, verify colors

- [ ] **Step 5: Final commit**

```bash
git add -A && git commit -m "feat(ios): update Config with server URLs, ready for testing"
```

---

### Task 9: Add .gitignore and clean up

**Files:**
- Create: `ios/.gitignore`

- [ ] **Step 1: Write ios/.gitignore**

```gitignore
# Xcode
*.xcuserdata/
*.xcworkspace/xcuserdata/
DerivedData/
build/
*.pbxuser
*.mode1v3
*.mode2v3
*.perspectivev3
xcuserdata/
*.moved-aside
*.hmap
*.ipa
*.dSYM.zip
*.dSYM

# Swift Package Manager
.build/
Packages/
.swiftpm/xcode/package.xcworkspace/contents.xcworkspacedata
```

- [ ] **Step 2: Commit everything**

```bash
git add -A && git commit -m "chore(ios): add .gitignore for Xcode artifacts"
```

- [ ] **Step 3: Update CLAUDE.md**

Add iOS app section to the project's CLAUDE.md:

```markdown
## iOS App
- `ios/` — Native SwiftUI voice client (equivalent to mobile.html)
- LiveKit Swift SDK via SPM
- AirPods Pro squeeze / AirPods Max Digital Crown → mute/unmute
- Hardcoded server URL in `ios/VoiceAssistant/Config.swift`
- Sideload via Xcode (no Apple Developer account needed)
- Build: open `ios/VoiceAssistant.xcodeproj` in Xcode, run on device
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md && git commit -m "docs: add iOS app section to CLAUDE.md"
```
