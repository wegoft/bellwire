// SPDX-License-Identifier: MPL-2.0
import AppIntents

struct BellwireProjectWidgetEntity: AppEntity, Hashable {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Project")
    static var defaultQuery = BellwireProjectEntityQuery()

    let id: String
    let name: String
    let icon: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

struct BellwireProjectEntityQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [BellwireProjectWidgetEntity] {
        let identifiers = Set(identifiers)
        return Self.projects().filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [BellwireProjectWidgetEntity] {
        Self.projects()
    }

    func defaultResult() async -> BellwireProjectWidgetEntity? {
        Self.projects().first
    }

    private static func projects() -> [BellwireProjectWidgetEntity] {
        let surfaces = BellwireWidgetSnapshotStore.read()?.surfaces ?? []
        var seen = Set<String>()
        return surfaces.compactMap { surface in
            guard seen.insert(surface.projectID).inserted else { return nil }
            return BellwireProjectWidgetEntity(
                id: surface.projectID,
                name: surface.projectName,
                icon: surface.projectIcon
            )
        }
    }
}

struct BellwireSurfaceWidgetEntity: AppEntity, Hashable {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Card")
    static var defaultQuery = BellwireSurfaceEntityQuery()

    let id: String
    let projectID: String
    let projectName: String
    let title: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: "\(projectName)")
    }
}

struct BellwireSurfaceEntityQuery: EntityQuery {
    @IntentParameterDependency<BellwireSurfaceWidgetIntent>(\.$project)
    var intent

    func entities(for identifiers: [String]) async throws -> [BellwireSurfaceWidgetEntity] {
        let identifiers = Set(identifiers)
        return Self.surfaces().filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [BellwireSurfaceWidgetEntity] {
        guard let projectID = intent?.project.id else { return Self.surfaces() }
        return Self.surfaces().filter { $0.projectID == projectID }
    }

    func defaultResult() async -> BellwireSurfaceWidgetEntity? {
        let surfaces = Self.surfaces()
        guard let projectID = intent?.project.id else { return surfaces.first }
        return surfaces.first { $0.projectID == projectID }
    }

    private static func surfaces() -> [BellwireSurfaceWidgetEntity] {
        (BellwireWidgetSnapshotStore.read()?.surfaces ?? []).map { surface in
            BellwireSurfaceWidgetEntity(
                id: surface.id,
                projectID: surface.projectID,
                projectName: surface.projectName,
                title: surface.title
            )
        }
    }
}
