// SPDX-License-Identifier: MPL-2.0
import SwiftUI
import UIKit

struct EventDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.locale) private var locale
    let eventID: String
    @State private var detail: EventDetail?
    @State private var loadError: String?
    @State private var revealedFields: Set<String> = []
    @State private var showsRawJSON = false
    @State private var copiedRawJSON = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: BellwireSpacing.section) {
                if let detail {
                    header(detail)
                    fields(detail)
                    delivery(detail)
                    TechnicalDisclosure(title: "Technical details") {
                        VStack(alignment: .leading, spacing: BellwireSpacing.roomy) {
                            identifiers(detail)
                            rawJSON(detail)
                        }
                        .padding(.vertical, BellwireSpacing.standard)
                    }
                } else if let loadError {
                    EmptyState(icon: "wifi.exclamationmark", title: "Event unavailable", message: loadError)
                        .bellwireSurface(elevated: false)
                } else {
                    LoadingEventRows()
                }
            }
            .padding(.horizontal, BellwireSpacing.roomy)
            .padding(.top, BellwireSpacing.standard)
            .padding(.bottom, BellwireSpacing.large)
        }
        .bellwirePageBackground()
        .navigationTitle("Event")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let detail {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: shareText(detail)) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .accessibilityLabel("Share event")
                }
            }
        }
        .task(id: eventID) { await load() }
    }

    private func header(_ event: EventDetail) -> some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.standard) {
            Text(event.eventType)
                .font(BellwireTypography.technicalStrong)
                .foregroundStyle(BellwireTheme.accent)
                .padding(.horizontal, 9)
                .frame(minHeight: 28)
                .background(BellwireTheme.accent.opacity(0.13), in: RoundedRectangle(cornerRadius: BellwireRadius.small, style: .continuous))

            Text(event.eventType.humanizedEventType)
                .font(.system(.largeTitle, design: .serif, weight: .regular))
                .tracking(-0.5)
                .foregroundStyle(BellwireTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)

            HStack(spacing: BellwireSpacing.compact) {
                ProjectAvatarView(
                    name: event.project.name,
                    icon: event.project.icon,
                    size: 24,
                    logoURL: event.project.logoUrl.flatMap(URL.init(string:))
                )
                Text(event.project.name)
                    .lineLimit(1)
                if let date = event.occurredDate {
                    Text("·")
                    Text(BellwireDateFormatting.dateTime(date, locale: locale))
                        .monospacedDigit()
                }
            }
            .font(.caption)
            .foregroundStyle(BellwireTheme.mutedInk)
            if let date = event.occurredDate {
                Text("Received \(BellwireDateFormatting.relative(date, locale: locale, unitsStyle: .full))")
                    .font(.caption2)
                    .foregroundStyle(BellwireTheme.mutedInk)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func fields(_ event: EventDetail) -> some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            SectionHeaderView(title: "Structured fields", hint: "\(event.data.count) fields")
            VStack(spacing: 0) {
                ForEach(Array(event.data.keys.sorted().enumerated()), id: \.element) { index, key in
                    let isSensitive = event.sensitiveFields.contains(key)
                    StructuredFieldRow(
                        key: key,
                        value: event.data[key]?.displayValue ?? "—",
                        isSensitive: isSensitive,
                        isRevealed: revealedFields.contains(key),
                        reveal: { revealedFields.insert(key) }
                    )
                    if index < event.data.count - 1 { Divider().overlay(BellwireTheme.separator) }
                }
            }
            .padding(.horizontal, BellwireSpacing.standard)
            .bellwireListGroup()
        }
    }

    private func delivery(_ event: EventDetail) -> some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            SectionHeaderView(title: "Delivery", hint: event.deliveries.isEmpty ? "Waiting" : nil)
            VStack(alignment: .leading, spacing: BellwireSpacing.standard) {
                DeliveryTimelineView(deliveries: event.deliveries)
                if event.deliveries.isEmpty {
                    Divider().overlay(BellwireTheme.separator)
                    Text("Waiting for a registered device or the next delivery attempt.")
                        .font(.caption)
                        .foregroundStyle(BellwireTheme.mutedInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(BellwireSpacing.standard)
            .bellwireListGroup()
        }
    }

    private func rawJSON(_ event: EventDetail) -> some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            HStack {
                Text("Raw JSON")
                    .bellwireTechnicalLabel()
                Spacer()
                Button {
                    UIPasteboard.general.string = redactedJSON(event)
                    copiedRawJSON = true
                    BellwireHaptics.success()
                } label: {
                    Label(copiedRawJSON ? "Copied" : "Copy", systemImage: copiedRawJSON ? "checkmark" : BellwireIcons.copy)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(BellwireTheme.accent)
                        .frame(minHeight: 44)
                }
                .buttonStyle(PressableButtonStyle())
            }
            DisclosureGroup(isExpanded: $showsRawJSON) {
                ScrollView(.horizontal, showsIndicators: true) {
                    Text(redactedJSON(event))
                        .font(BellwireTypography.technical)
                        .foregroundStyle(BellwireTheme.secondaryInk)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(.top, BellwireSpacing.standard)
                }
            } label: {
                Label(showsRawJSON ? "Hide payload" : "Show redacted payload", systemImage: "curlybraces")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(BellwireTheme.ink)
            }
            .padding(BellwireSpacing.standard)
            .background(BellwireTheme.raisedSurface, in: RoundedRectangle(cornerRadius: BellwireRadius.card, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: BellwireRadius.card, style: .continuous)
                    .stroke(BellwireTheme.separator, lineWidth: 1)
            }
        }
    }

    private func identifiers(_ event: EventDetail) -> some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            SectionHeaderView(title: "Technical")
            VStack(spacing: 0) {
                StructuredFieldRow(key: "event_id", value: event.id)
                Divider().overlay(BellwireTheme.separator)
                if let idempotencyKeyHash = event.idempotencyKeyHash {
                    StructuredFieldRow(key: "idempotency_hash", value: idempotencyKeyHash)
                }
            }
            .padding(.horizontal, BellwireSpacing.standard)
            .bellwireListGroup()
        }
    }

    private func load() async {
        loadError = nil
        do {
            detail = try await model.loadEvent(id: eventID)
            await model.markRead(id: eventID)
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func redactedJSON(_ event: EventDetail) -> String {
        var values = event.data
        for key in event.sensitiveFields where !revealedFields.contains(key) { values[key] = .string("••••••") }
        guard let data = try? JSONEncoder().encode(values),
              let object = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        else { return "{}" }
        return String(data: pretty, encoding: .utf8) ?? "{}"
    }

    private func shareText(_ event: EventDetail) -> String {
        """
        \(event.eventType.humanizedEventType)
        Project: \(event.project.name)
        Event ID: \(event.id)

        \(redactedJSON(event))
        """
    }
}

struct ProjectDetailView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var purchaseManager: PurchaseManager
    @Environment(\.dismiss) private var dismiss
    let projectID: String
    @State private var overview: ProjectOverview?
    @State private var events: [InboxEvent] = []
    @State private var errorMessage: String?
    @State private var isUpdating = false
    @State private var isDeleting = false
    @State private var showsDeleteConfirmation = false
    @State private var showsPaywall = false
    @State private var copiedEndpoint = false
    @State private var isExporting = false
    @State private var exportDocument: ProjectExportDocument?
    @State private var liveActivitySurfaceIDs = Set<String>()

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: BellwireSpacing.section) {
                if let overview {
                    if let errorMessage {
                        ErrorBanner(message: errorMessage) { self.errorMessage = nil }
                    }
                    projectHeader(overview)
                    planUsage(overview)
                    health(overview)
                    liveSurfaces(overview)
                    recentEvents
                    TechnicalDisclosure(title: "Technical details") {
                        VStack(alignment: .leading, spacing: BellwireSpacing.roomy) {
                            deliveryMode(overview)
                            eventTypes(overview)
                            endpoint(overview)
                        }
                        .padding(.vertical, BellwireSpacing.standard)
                    }
                    dangerZone
                } else if let errorMessage {
                    EmptyState(icon: "wifi.exclamationmark", title: "Project unavailable", message: errorMessage)
                        .bellwireSurface(elevated: false)
                } else {
                    LoadingEventRows()
                }
            }
            .padding(.horizontal, BellwireSpacing.roomy)
            .padding(.top, BellwireSpacing.standard)
            .padding(.bottom, BellwireSpacing.large)
        }
        .bellwirePageBackground()
        .navigationTitle(overview?.name ?? "Project")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let project = overview {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            export(project)
                        } label: {
                            Label("Export JSON", systemImage: "arrow.down.doc")
                        }
                        .disabled(isExporting || isDeleting)

                        Button {
                            isUpdating = true
                            Task { await togglePause(project) }
                        } label: {
                            Label(
                                project.status == "paused" ? "Resume project" : "Pause project",
                                systemImage: project.status == "paused" ? "play.fill" : "pause.fill"
                            )
                        }
                        .disabled(isUpdating || isDeleting)
                    } label: {
                        Group {
                            if isExporting || isUpdating {
                                ProgressView()
                                    .controlSize(.small)
                            } else {
                                Image(systemName: "ellipsis.circle")
                            }
                        }
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Project actions")
                    .disabled(isUpdating || isExporting || isDeleting)
                }
            }
        }
        .refreshable { await load() }
        .task(id: projectID) { await load() }
        .alert("Delete project?", isPresented: $showsDeleteConfirmation) {
            Button("Delete project", role: .destructive) {
                Task { await deleteProject() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This permanently deletes the project, its events, notification configuration, tokens, and live surfaces. This action cannot be undone.")
        }
        .sheet(item: $exportDocument) { document in
            ProjectExportShareSheet(url: document.url)
        }
        .sheet(isPresented: $showsPaywall) {
            PaywallView(appAccountToken: model.session.flatMap { UUID(uuidString: $0.user.id) })
                .environmentObject(purchaseManager)
                .presentationDetents([.large])
                .presentationDragIndicator(.hidden)
                .presentationCornerRadius(BellwireRadius.hero)
                .presentationBackground(BellwireTheme.background)
        }
    }

    private func projectHeader(_ project: ProjectOverview) -> some View {
        HStack(spacing: BellwireSpacing.standard) {
            ProjectAvatarView(
                name: project.name,
                icon: project.icon,
                size: 64,
                logoURL: project.logoUrl.flatMap(URL.init(string:))
            )
            VStack(alignment: .leading, spacing: 7) {
                Text(project.name)
                    .font(.system(.title, design: .serif, weight: .regular))
                    .foregroundStyle(BellwireTheme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: BellwireSpacing.compact) {
                    if isUpdating {
                        HStack(spacing: 6) {
                            ProgressView()
                                .controlSize(.mini)
                                .tint(BellwireTheme.accent)
                            Text(project.status == "paused" ? "Resuming…" : "Pausing…")
                        }
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(BellwireTheme.accent)
                        .padding(.horizontal, 9)
                        .frame(minHeight: 26)
                        .background(
                            BellwireTheme.accent.opacity(0.13),
                            in: RoundedRectangle(cornerRadius: BellwireRadius.small, style: .continuous)
                        )
                    } else {
                        StatusBadgeView(
                            text: project.status == "paused" ? "Paused" : "Active",
                            color: project.status == "paused" ? BellwireTheme.mutedInk : BellwireTheme.success
                        )
                    }
                    StatusBadgeView(
                        text: project.deliveryMode == .private ? "Private" : "Hosted",
                        color: project.deliveryMode == .private
                            ? BellwireTheme.success
                            : BellwireTheme.warning,
                        showsDot: false
                    )
                    Text(project.category.capitalized)
                        .font(.caption)
                        .foregroundStyle(BellwireTheme.mutedInk)
                }
            }
            Spacer()
        }
        .accessibilityElement(children: .combine)
    }

    private func deliveryMode(_ project: ProjectOverview) -> some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            SectionHeaderView(title: "Data path")
            HStack(alignment: .top, spacing: BellwireSpacing.standard) {
                Image(
                    systemName: project.deliveryMode == .private
                        ? "lock.shield.fill"
                        : "cloud.fill"
                )
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(
                    project.deliveryMode == .private
                        ? BellwireTheme.success
                        : BellwireTheme.warning
                )
                VStack(alignment: .leading, spacing: 5) {
                    Text(project.deliveryMode == .private ? "Private delivery" : "Hosted delivery")
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(BellwireTheme.ink)
                    if project.deliveryMode == .private {
                        Text(
                            "\(project.privateReadiness.readyDevices)/\(project.privateReadiness.activeDevices) devices ready · Notification, Inbox, and Surface details come directly from your service."
                        )
                        .font(.caption)
                        .foregroundStyle(BellwireTheme.secondaryInk)
                        if let lastSyncAt = model.privateLastSyncAt[project.id] {
                            HStack(spacing: 4) {
                                Text("Last local sync")
                                Text(lastSyncAt, style: .relative)
                            }
                            .font(.caption2)
                            .foregroundStyle(BellwireTheme.mutedInk)
                        } else {
                            Text("Never synced")
                                .font(.caption2)
                                .foregroundStyle(BellwireTheme.mutedInk)
                        }
                        if let error = model.privateSyncErrors[project.id] {
                            Text(error)
                                .font(.caption)
                                .foregroundStyle(BellwireTheme.danger)
                        }
                    } else {
                        Text("Bellwire Cloud stores Event, Inbox, Surface, and detailed notification content according to your plan retention.")
                            .font(.caption)
                            .foregroundStyle(BellwireTheme.secondaryInk)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            .padding(BellwireSpacing.standard)
            .bellwireSurface(elevated: false)
        }
    }

    @ViewBuilder
    private func planUsage(_ project: ProjectOverview) -> some View {
        if let entitlement = model.entitlement {
            VStack(alignment: .leading, spacing: BellwireSpacing.small) {
                SectionHeaderView(
                    title: "Plan & usage",
                    hint: entitlement.plan == "pro" ? "Pro" : "Free"
                )
                VStack(alignment: .leading, spacing: BellwireSpacing.standard) {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(entitlement.usage.acceptedSignals.formatted()) / \(entitlement.limits.monthlySignals.formatted()) Signals")
                                .font(BellwireTypography.technicalStrong)
                                .foregroundStyle(BellwireTheme.ink)
                            Text(
                                project.deliveryMode == .hosted
                                    ? "\(entitlement.limits.hostedRetentionDays)-day Hosted history"
                                    : "30-day Private history on this iPhone"
                            )
                            .font(.caption)
                            .foregroundStyle(BellwireTheme.secondaryInk)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 3) {
                            Text("\(project.liveSurfaces.count)/\(entitlement.limits.surfacesPerProject)")
                                .font(BellwireTypography.technicalStrong)
                                .foregroundStyle(BellwireTheme.accent)
                            Text("Surfaces")
                                .font(.caption2)
                                .foregroundStyle(BellwireTheme.mutedInk)
                        }
                    }
                    ProgressView(
                        value: min(
                            Double(entitlement.usage.acceptedSignals)
                                / Double(max(entitlement.limits.monthlySignals, 1)),
                            1.1
                        )
                    )
                    .tint(BellwireTheme.accent)
                    if let resetDate = ISO8601DateFormatter.bellwireDate(
                        from: entitlement.usage.periodEnd
                    ) {
                        Text("Resets \(resetDate, format: .dateTime.month().day().hour().minute())")
                            .font(.caption2)
                            .foregroundStyle(BellwireTheme.mutedInk)
                    }
                }
                .padding(BellwireSpacing.standard)
                .bellwireSurface(elevated: false)
            }
        }
    }

    @ViewBuilder
    private func liveSurfaces(_ project: ProjectOverview) -> some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            SectionHeaderView(title: "Live surfaces", hint: project.liveSurfaces.isEmpty ? nil : "\(project.liveSurfaces.count) active")
            if project.liveSurfaces.isEmpty {
                EmptyState(
                    icon: "waveform.path.ecg",
                    title: "No live surfaces",
                    message: "This project has not published a live progress, metric, or alert surface."
                )
                .bellwireSurface(elevated: false)
            } else {
                ForEach(project.liveSurfaces) { surface in
                    VStack(spacing: BellwireSpacing.compact) {
                        LiveSurfaceCard(surface: surface)
                        Button {
                            toggleLiveActivity(surface)
                        } label: {
                            Label(
                                liveActivitySurfaceIDs.contains(surface.id)
                                    ? "Stop Live Activity"
                                    : "Start Live Activity",
                                systemImage: liveActivitySurfaceIDs.contains(surface.id)
                                    ? "xmark.circle"
                                    : "bolt.horizontal.circle.fill"
                            )
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(BellwireTheme.accent)
                            .frame(maxWidth: .infinity, minHeight: 38)
                        }
                        .buttonStyle(PressableButtonStyle())
                        .accessibilityHint(
                            liveActivitySurfaceIDs.contains(surface.id)
                                ? "Removes this Surface from the Lock Screen and Dynamic Island"
                                : "Shows this Surface on the Lock Screen and Dynamic Island"
                        )
                    }
                }
            }
        }
    }

    private func health(_ project: ProjectOverview) -> some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            SectionHeaderView(
                title: project.deliveryMode == .private
                    ? "Wake delivery · 24h"
                    : "Delivery health · 24h",
                hint: project.deliveryHealth.status.capitalized
            )
            HStack(spacing: 10) {
                healthMetric(project.deliveryHealth.accepted, "Accepted", BellwireTheme.success)
                Divider().overlay(BellwireTheme.separator).frame(height: 48)
                healthMetric(project.deliveryHealth.queued, "Queued", BellwireTheme.warning)
                Divider().overlay(BellwireTheme.separator).frame(height: 48)
                healthMetric(project.deliveryHealth.failed, "Failed", BellwireTheme.danger)
            }
            .padding(.horizontal, BellwireSpacing.standard)
            .bellwireListGroup()
        }
    }

    private func healthMetric(_ value: Int, _ title: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(value.formatted())
                .font(BellwireTypography.metric)
                .monospacedDigit()
            Text(title)
                .font(.caption)
                .foregroundStyle(BellwireTheme.mutedInk)
        }
        .foregroundStyle(BellwireTheme.ink)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 14)
        .accessibilityElement(children: .combine)
    }

    private func endpoint(_ project: ProjectOverview) -> some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            SectionHeaderView(
                title: project.deliveryMode == .private ? "Direct service" : "Event endpoint",
                hint: copiedEndpoint ? "Copied" : nil
            )
            VStack(alignment: .leading, spacing: BellwireSpacing.standard) {
                Text(fullEndpoint(project))
                    .font(BellwireTypography.technical)
                    .foregroundStyle(BellwireTheme.secondaryInk)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    UIPasteboard.general.string = fullEndpoint(project)
                    copiedEndpoint = true
                    BellwireHaptics.success()
                } label: {
                    Label(copiedEndpoint ? "Endpoint copied" : "Copy endpoint", systemImage: copiedEndpoint ? "checkmark" : BellwireIcons.copy)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(BellwireTheme.accentInk)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(BellwireTheme.accent, in: RoundedRectangle(cornerRadius: BellwireRadius.small, style: .continuous))
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityHint("Copies the full event endpoint")
            }
            .padding(BellwireSpacing.standard)
            .bellwireSurface(radius: BellwireRadius.card, elevated: false)
        }
    }

    private var dangerZone: some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            SectionHeaderView(title: "Danger zone")
            VStack(alignment: .leading, spacing: BellwireSpacing.standard) {
                Text("Delete this project and all of its associated data permanently.")
                    .font(.subheadline)
                    .foregroundStyle(BellwireTheme.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                Button(role: .destructive) {
                    showsDeleteConfirmation = true
                } label: {
                    HStack(spacing: BellwireSpacing.compact) {
                        if isDeleting {
                            ProgressView()
                                .tint(BellwireTheme.danger)
                        } else {
                            Image(systemName: "trash")
                        }
                        Text(isDeleting ? "Deleting project…" : "Delete project")
                            .font(.subheadline.weight(.semibold))
                    }
                    .foregroundStyle(BellwireTheme.danger)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(
                        BellwireTheme.danger.opacity(0.10),
                        in: RoundedRectangle(cornerRadius: BellwireRadius.small, style: .continuous)
                    )
                }
                .buttonStyle(PressableButtonStyle())
                .disabled(isDeleting || isUpdating)
                .accessibilityHint("Permanently deletes this project and all associated data")
            }
            .padding(BellwireSpacing.standard)
            .bellwireSurface(radius: BellwireRadius.card, elevated: false)
        }
    }

    private func eventTypes(_ project: ProjectOverview) -> some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            SectionHeaderView(title: "Configured event types", hint: schemaHint(project))
            if project.eventSchemas.isEmpty {
                EmptyState(
                    icon: "curlybraces",
                    title: "No event types configured",
                    message: "Your Agent can add schema-backed event types when it wires this project."
                )
                .bellwireSurface(elevated: false)
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 135), spacing: 8)], alignment: .leading, spacing: 8) {
                    ForEach(project.eventSchemas) { schema in
                        HStack(spacing: BellwireSpacing.compact) {
                            Text(schema.eventType)
                                .font(BellwireTypography.technical)
                                .lineLimit(1)
                            Spacer(minLength: 2)
                            Text("v\(schema.version)")
                                .font(.caption2)
                                .monospacedDigit()
                                .foregroundStyle(BellwireTheme.mutedInk)
                        }
                        .foregroundStyle(BellwireTheme.secondaryInk)
                        .padding(.horizontal, 11)
                        .frame(minHeight: 38)
                        .background(BellwireTheme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
    }

    private var recentEvents: some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            SectionHeaderView(title: "Recent events", hint: events.isEmpty ? nil : "Latest")
            if events.isEmpty {
                EmptyState(
                    icon: "tray",
                    title: "No events received",
                    message: "This project has not sent an event yet."
                )
                .bellwireSurface(elevated: false)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(events.prefix(8).enumerated()), id: \.element.id) { index, event in
                        NavigationLink(value: AppRoute.event(event.id)) { EventRow(event: event) }
                            .buttonStyle(PressableButtonStyle())
                        if index < min(events.count, 8) - 1 {
                            Divider().overlay(BellwireTheme.separator).padding(.leading, 52)
                        }
                    }
                }
                .padding(.horizontal, BellwireSpacing.standard)
                .bellwireListGroup()
            }
        }
    }

    private func load() async {
        errorMessage = nil
        do {
            let result = try await model.loadProject(id: projectID)
            overview = result.0
            events = result.1
            liveActivitySurfaceIDs = Set(
                result.0.liveSurfaces
                    .filter { model.isLiveActivityActive(surfaceID: $0.id) }
                    .map(\.id)
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func togglePause(_ project: ProjectOverview) async {
        isUpdating = true
        defer { isUpdating = false }
        do {
            _ = try await model.setProjectPaused(id: project.id, paused: project.status != "paused")
            BellwireHaptics.success()
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func deleteProject() async {
        guard !isDeleting else { return }
        isDeleting = true
        errorMessage = nil
        do {
            try await model.deleteProject(id: projectID)
            BellwireHaptics.success()
            dismiss()
        } catch {
            isDeleting = false
            errorMessage = error.localizedDescription
            BellwireHaptics.error()
        }
    }

    private func export(_ project: ProjectOverview) {
        guard model.entitlement?.hasPro == true else {
            Task { await model.captureProductEvent("upgrade_clicked", source: "project_export") }
            showsPaywall = true
            return
        }
        guard !isExporting else { return }
        isExporting = true
        Task {
            defer { isExporting = false }
            do {
                exportDocument = ProjectExportDocument(
                    url: try await model.exportProject(project)
                )
                BellwireHaptics.success()
            } catch {
                errorMessage = error.localizedDescription
                BellwireHaptics.error()
            }
        }
    }

    private func toggleLiveActivity(_ surface: LiveSurfaceRecord) {
        guard model.entitlement?.hasPro == true else {
            Task { await model.captureProductEvent("upgrade_clicked", source: "live_activity") }
            showsPaywall = true
            return
        }
        Task {
            do {
                if liveActivitySurfaceIDs.contains(surface.id) {
                    await model.stopLiveActivity(surfaceID: surface.id)
                    liveActivitySurfaceIDs.remove(surface.id)
                } else {
                    try await model.startLiveActivity(for: surface)
                    liveActivitySurfaceIDs.insert(surface.id)
                    BellwireHaptics.success()
                }
            } catch {
                errorMessage = error.localizedDescription
                BellwireHaptics.error()
            }
        }
    }

    private func fullEndpoint(_ project: ProjectOverview) -> String {
        AppConfig.apiBaseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            + "/"
            + project.endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    private func schemaHint(_ project: ProjectOverview) -> String? {
        guard let version = project.eventSchemas.map(\.version).max() else { return nil }
        return "Schema v\(version)"
    }
}

private struct ProjectExportDocument: Identifiable {
    let id = UUID()
    let url: URL
}

private struct ProjectExportShareSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(
        _ uiViewController: UIActivityViewController,
        context: Context
    ) {}
}
