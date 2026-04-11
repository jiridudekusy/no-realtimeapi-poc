import SwiftUI

struct SettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var serverURL = Config.serverURL
    @State private var livekitURL = Config.livekitURL

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("Token Server URL", text: $serverURL)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .font(.system(size: 14, design: .monospaced))
                    TextField("LiveKit WSS URL", text: $livekitURL)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .font(.system(size: 14, design: .monospaced))
                }

                Section {
                    Button("Reset to Defaults") {
                        serverURL = Config.defaultServerURL
                        livekitURL = Config.defaultLiveKitURL
                    }
                    .foregroundStyle(.red)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Config.serverURL = serverURL
                        Config.livekitURL = livekitURL
                        dismiss()
                    }
                    .bold()
                }
            }
        }
    }
}
