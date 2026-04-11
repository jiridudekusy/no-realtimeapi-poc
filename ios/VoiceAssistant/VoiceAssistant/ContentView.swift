import SwiftUI

struct ContentView: View {
    @StateObject private var lk = LiveKitService()
    @StateObject private var projects = ProjectService()
    @State private var showProjectSheet = false

    var body: some View {
        VStack(spacing: 0) {
            projectBar
            transcriptArea
                .padding(.top, 8)
            controlButtons
                .padding(.top, 14)
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
