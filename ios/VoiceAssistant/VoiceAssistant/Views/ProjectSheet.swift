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
