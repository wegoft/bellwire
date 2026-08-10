// SPDX-License-Identifier: MPL-2.0
import AppIntents

struct BellwireSurfaceWidgetIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Choose a Card"
    static var description = IntentDescription("Choose a project and card to display.")

    @Parameter(title: "Project")
    var project: BellwireProjectWidgetEntity?

    @Parameter(title: "Card")
    var surface: BellwireSurfaceWidgetEntity?

    init() {}

    init(project: BellwireProjectWidgetEntity?, surface: BellwireSurfaceWidgetEntity?) {
        self.project = project
        self.surface = surface
    }
}

struct BellwireProjectOverviewWidgetIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Choose a Project"
    static var description = IntentDescription("Choose a project to display.")

    @Parameter(title: "Project")
    var project: BellwireProjectWidgetEntity?

    init() {}

    init(project: BellwireProjectWidgetEntity?) {
        self.project = project
    }
}
