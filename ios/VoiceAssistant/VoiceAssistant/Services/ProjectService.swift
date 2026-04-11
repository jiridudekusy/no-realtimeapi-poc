import Foundation
import Combine

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
