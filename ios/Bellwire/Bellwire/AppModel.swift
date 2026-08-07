// SPDX-License-Identifier: MPL-2.0
import AuthenticationServices
import ActivityKit
import CryptoKit
import Security
import SwiftUI
import UIKit
import UserNotifications

enum NotificationPermissionState: Equatable {
    case unknown
    case notDetermined
    case denied
    case authorized

    var label: String {
        switch self {
        case .unknown: return "Checking"
        case .notDetermined: return "Not requested"
        case .denied: return "Off"
        case .authorized: return "On"
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var session: AuthSession?
    @Published private(set) var projects: [ProjectSummary] = []
    @Published private(set) var liveSurfaces: [LiveSurfaceRecord] = []
    @Published private(set) var events: [InboxEvent] = []
    @Published private(set) var devices: [DeviceRecord] = []
    @Published private(set) var agentConnections: [AgentConnectionRecord] = []
    @Published private(set) var entitlement: AccountEntitlement?
    @Published private(set) var pendingModeRequests: [DeliveryModeChangeRequest] = []
    @Published private(set) var resolvingModeRequestID: String?
    @Published private(set) var modeRequestErrors: [String: String] = [:]
    @Published private(set) var privateSyncErrors: [String: String] = [:]
    @Published private(set) var privateLastSyncAt: [String: Date] = [:]
    @Published private(set) var revokingAgentConnectionID: String?
    @Published private(set) var notificationPermission: NotificationPermissionState = .unknown
    @Published private(set) var notificationAuthorizationDiagnostic = "unknown"
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingLiveSurfaces = false
    @Published private(set) var hasCompletedInitialDashboardLoad = false
    @Published private(set) var hasLoadedDashboardSuccessfully = false
    @Published private(set) var isAuthenticating = false
    @Published private(set) var isMarkingAllRead = false
    @Published private(set) var isCreatingDemo = false
    @Published private(set) var lastDashboardRefreshAt: Date?
    @Published var errorMessage: String?
    @Published var binding: BindingResponse?
    @Published var pendingEventID: String?
    @Published var pendingModeRequestNavigation = false

    private let keychain = KeychainStore()
    private let privateEventStore = PrivateEventStore()
    private var currentNonce: String?
    private var apnsToken: String?
    private var dashboardLoadTask: Task<Void, Never>?
    private var dashboardLoadID: UUID?
    private var sessionRefreshTask: Task<AuthSession, Error>?
    private var liveActivityUpdatesTask: Task<Void, Never>?
    private var pushToStartTokenTask: Task<Void, Never>?
    private var observedLiveActivityTasks: [String: Task<Void, Never>] = [:]
    private var pushToStartToken: String?

    lazy var api = APIClient { [weak self] in
        guard let self else { throw ClientError.signedOut }
        return try await self.validAccessToken()
    }

    init() {
#if DEBUG
        if let mode = Self.screenshotMode {
            let isWelcome = mode == "welcome"
            let isEmptyState = mode == "home-empty" || mode == "projects-empty"
            session = isWelcome ? nil : AuthSession(
                accessToken: "app-store-screenshot",
                refreshToken: "app-store-screenshot",
                expiresAt: .distantFuture,
                user: AuthUser(id: "screenshot-user", email: "hello@bellwire.app")
            )
            if !isWelcome {
                UserDefaults.standard.set(true, forKey: "notificationOnboardingSeen")
                if !isEmptyState { loadScreenshotFixtures() }
                hasCompletedInitialDashboardLoad = true
                hasLoadedDashboardSuccessfully = true
            }
            return
        }
#endif
        if let stored = keychain.read(), stored.issuer == AppConfig.authBaseURL.absoluteString {
            session = stored
        } else {
            keychain.delete()
            session = nil
        }
    }

    var isAuthenticated: Bool { session != nil }
    var isPreparingInitialDashboard: Bool {
        isAuthenticated && !hasCompletedInitialDashboardLoad
    }
    var unreadCount: Int { events.filter(\.isUnread).count }
    var todayCount: Int {
        events.filter { event in
            guard let date = event.receivedDate else { return false }
            return Calendar.current.isDateInToday(date)
        }.count
    }

    func bootstrap() async {
#if DEBUG
        if Self.screenshotMode != nil { return }
#endif
        await refreshNotificationStatus()
        guard isAuthenticated else { return }
        startLiveActivityObservers()
        if notificationPermission == .authorized, apnsToken == nil {
            UIApplication.shared.registerForRemoteNotifications()
        }
        await loadDashboard(showLoading: true)
    }

    func handleBecameActive() async {
#if DEBUG
        if Self.screenshotMode != nil { return }
#endif
        await refreshNotificationStatus()
        guard isAuthenticated else { return }
        if notificationPermission == .authorized, apnsToken == nil {
            UIApplication.shared.registerForRemoteNotifications()
        }
        if lastDashboardRefreshAt.map({ Date().timeIntervalSince($0) > 10 }) ?? true {
            await loadDashboard()
        }
    }

#if DEBUG
    private static var screenshotMode: String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-BellwireScreenshot"),
              arguments.indices.contains(index + 1)
        else { return nil }
        return arguments[index + 1]
    }

    private func loadScreenshotFixtures() {
        let now = "2026-07-22T16:28:00Z"
        let earlier = "2026-07-22T16:15:00Z"
        let store = ProjectSummary(
            id: "store", name: "Northstar Store", slug: "northstar-store", icon: "cart.fill",
            logoUrl: nil, displayOrder: 0, category: "commerce", status: "active",
            deliveryMode: .hosted,
            endpoint: "https://api.bellwire.app/v1/ingest/demo", createdAt: earlier, updatedAt: now
        )
        let agent = ProjectSummary(
            id: "agent", name: "Weekly Report Agent", slug: "weekly-report-agent", icon: "gearshape.2.fill",
            logoUrl: nil, displayOrder: 1, category: "automation", status: "active",
            deliveryMode: .private,
            endpoint: "https://api.bellwire.app/v1/ingest/demo", createdAt: earlier, updatedAt: now
        )
        let deploy = ProjectSummary(
            id: "deploy", name: "Production Deploy", slug: "production-deploy", icon: "shippingbox.fill",
            logoUrl: nil, displayOrder: 2, category: "engineering", status: "active",
            deliveryMode: .hosted,
            endpoint: "https://api.bellwire.app/v1/ingest/demo", createdAt: earlier, updatedAt: now
        )
        projects = [store, agent, deploy]
        liveSurfaces = [
            LiveSurfaceRecord(
                id: "surface-agent", projectId: agent.id, surfaceKey: "weekly-run", type: "progress",
                title: "Weekly report", subtitle: "Analyzing 18 sources", content: [
                    "percentage": .number(72),
                    "metrics": .array([
                        .object(["label": .string("Sources"), "value": .number(18)]),
                        .object(["label": .string("Complete"), "value": .string("72%")])
                    ])
                ], action: nil, displayOrder: 0, version: 1, createdAt: earlier, updatedAt: now,
                project: EventProject(id: agent.id, name: agent.name, icon: agent.icon, logoUrl: nil)
            )
        ]
        events = [
            InboxEvent(
                id: "payment", projectId: store.id, eventType: "payment.received",
                data: ["amount": .string("$128.00"), "product": .string("Creator Plan")],
                occurredAt: now, receivedAt: now, status: "delivered", readAt: nil,
                project: EventProject(id: store.id, name: store.name, icon: store.icon, logoUrl: nil),
                sensitiveFields: []
            ),
            InboxEvent(
                id: "agent-run", projectId: agent.id, eventType: "agent.run.in_progress",
                data: ["status": .string("Running"), "message": .string("Weekly report")],
                occurredAt: earlier, receivedAt: earlier, status: "delivered", readAt: nil,
                project: EventProject(id: agent.id, name: agent.name, icon: agent.icon, logoUrl: nil),
                sensitiveFields: []
            ),
            InboxEvent(
                id: "deployment", projectId: deploy.id, eventType: "deployment.completed",
                data: ["status": .string("Production"), "message": .string("Build 184")],
                occurredAt: earlier, receivedAt: earlier, status: "delivered", readAt: earlier,
                project: EventProject(id: deploy.id, name: deploy.name, icon: deploy.icon, logoUrl: nil),
                sensitiveFields: []
            )
        ]
        devices = [
            DeviceRecord(
                id: "iphone", name: "iPhone", platform: "ios", apnsEnvironment: "sandbox", appVersion: "1.0",
                buildNumber: "11", notificationAuthorization: "authorized",
                lastActiveAt: now, pushEnabled: true
            )
        ]
        notificationPermission = .authorized
    }
#endif

    func configureAppleRequest(_ request: ASAuthorizationAppleIDRequest) {
        let nonce = randomNonce()
        currentNonce = nonce
        request.requestedScopes = [.email, .fullName]
        request.nonce = SHA256.hash(data: Data(nonce.utf8)).compactMap { String(format: "%02x", $0) }.joined()
    }

    func completeAppleAuthorization(_ result: Result<ASAuthorization, Error>) async {
        isAuthenticating = true
        errorMessage = nil
        defer { isAuthenticating = false }
        do {
            let authorization = try result.get()
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential
            else { throw ClientError.api(code: "APPLE_CREDENTIAL_INVALID", message: "Apple did not return a valid sign-in credential.") }
            guard let tokenData = credential.identityToken,
                  let identityToken = String(data: tokenData, encoding: .utf8),
                  !identityToken.isEmpty
            else { throw ClientError.api(code: "APPLE_TOKEN_MISSING", message: "Apple did not return a valid identity token.") }
            guard let nonce = currentNonce
            else { throw ClientError.api(code: "APPLE_NONCE_MISSING", message: "Apple sign-in could not verify this request. Please try again.") }
            let authorizationCode = credential.authorizationCode
                .flatMap { String(data: $0, encoding: .utf8) }
                .flatMap { $0.isEmpty ? nil : $0 }
            let newSession = try await api.exchangeAppleIdentityToken(
                identityToken,
                nonce: nonce,
                authorizationCode: authorizationCode,
                email: credential.email,
                fullName: credential.fullName
            )
            try saveSession(newSession)
            await loadDashboard(showLoading: true)
            startLiveActivityObservers()
            if let apnsToken {
                await registerDevice(apnsToken)
            } else if notificationPermission == .authorized {
                UIApplication.shared.registerForRemoteNotifications()
            }
        } catch {
            errorMessage = friendlyMessage(error)
        }
        currentNonce = nil
    }

    func loadDashboard(showLoading: Bool = false) async {
        if let dashboardLoadTask {
            await dashboardLoadTask.value
            return
        }
        let isInitialLoad = !hasCompletedInitialDashboardLoad
        if showLoading || isInitialLoad { isLoading = true }
        isLoadingLiveSurfaces = true
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.performDashboardLoad()
        }
        let loadID = UUID()
        dashboardLoadTask = task
        dashboardLoadID = loadID
        await task.value
        if dashboardLoadID == loadID {
            dashboardLoadTask = nil
            dashboardLoadID = nil
            if isInitialLoad { hasCompletedInitialDashboardLoad = true }
            if showLoading || isInitialLoad { isLoading = false }
            isLoadingLiveSurfaces = false
        }
    }

    private func performDashboardLoad() async {
        guard let userID = session?.user.id else { return }
        let storedDirectConnections = keychain.directConnectionManifests(userID: userID)
        let directProjectIDs = Set(storedDirectConnections.map(\.project.id))
        let cachedDirectSurfaces = deduplicatedSurfaces(
            liveSurfaces.filter { directProjectIDs.contains($0.projectId) }
        )
        do {
            async let deviceKeyRegistration: Void? = try? registerCurrentDeviceKey(userID: userID)
            async let projectRequest: ProjectsResponse = api.request("v1/projects")
            async let surfaceRequest: LiveSurfacesResponse = api.request("v1/surfaces")
            async let inboxRequest: InboxResponse = api.request("v1/inbox?limit=60")
            async let deviceRequest: DevicesResponse? = try? api.request("v1/devices")
            async let connectionRequest: AgentConnectionsResponse? = try? api.request(
                "v1/agent-connections"
            )
            async let entitlementRequest: AccountEntitlement? = try? api.request(
                "v1/account/entitlement"
            )
            async let modeRequest: DeliveryModeChangeRequestsResponse? = try? api.request(
                "v1/delivery-mode-requests?status=pending"
            )
            let (projectResponse, surfaceResponse) = try await (
                projectRequest,
                surfaceRequest
            )
            guard !Task.isCancelled, session?.user.id == userID else { return }
            let orderedProjects = projectResponse.projects.sorted(by: stableProjectOrder)
            let missingManifestProjects = orderedProjects.filter { project in
                project.deliveryMode == .private && !directProjectIDs.contains(project.id)
            }
            let hostedProjectIDs = Set(
                orderedProjects.filter { project in
                    project.deliveryMode == .hosted
                }.map(\.id)
            )
            let projectOrders = Dictionary(uniqueKeysWithValues: orderedProjects.map { ($0.id, $0.displayOrder) })
            let orderedSurfaces = surfaceResponse.surfaces.sorted { left, right in
                let leftProjectOrder = projectOrders[left.projectId] ?? Int.max
                let rightProjectOrder = projectOrders[right.projectId] ?? Int.max
                if leftProjectOrder != rightProjectOrder { return leftProjectOrder < rightProjectOrder }
                if left.displayOrder != right.displayOrder { return left.displayOrder < right.displayOrder }
                return left.id < right.id
            }
            projects = orderedProjects
            let privateProjectIDs = Set(
                projects.filter { $0.deliveryMode == .private }.map(\.id)
            )
            let cloudSurfaces = orderedSurfaces.filter {
                hostedProjectIDs.contains($0.projectId)
            }
            let currentDirectSurfaces = cachedDirectSurfaces.filter {
                privateProjectIDs.contains($0.projectId)
            }
            for project in projects where project.deliveryMode == .private {
                if let fetchedAt = privateEventStore.lastFetchedAt(
                    accountID: userID,
                    projectID: project.id
                ) {
                    privateLastSyncAt[project.id] = fetchedAt
                }
            }
            liveSurfaces = sortedSurfaces(
                deduplicatedSurfaces(cloudSurfaces + currentDirectSurfaces),
                projects: projects
            )

            _ = await deviceKeyRegistration
            for project in missingManifestProjects {
                await requestDirectConnectionRecovery(project: project, userID: userID)
            }
            await refreshDirectConnections(userID: userID)
            guard !Task.isCancelled, session?.user.id == userID else { return }
            isLoadingLiveSurfaces = false

            let inboxResponse = try await inboxRequest
            guard !Task.isCancelled, session?.user.id == userID else { return }
            let cachedPrivateEvents = privateEventStore.inboxEvents(
                accountID: userID,
                projects: projects
            )
            events = ProjectDataConsistency.normalizeEvents(
                inboxResponse.events + cachedPrivateEvents,
                projects: projects
            )
                .sorted { $0.receivedAt > $1.receivedAt }
            lastDashboardRefreshAt = .now
            hasLoadedDashboardSuccessfully = true
            hasCompletedInitialDashboardLoad = true
            isLoading = false
            errorMessage = nil

            let (
                deviceResponse,
                connectionResponse,
                entitlementResponse,
                modeResponse
            ) = await (
                deviceRequest,
                connectionRequest,
                entitlementRequest,
                modeRequest
            )
            guard !Task.isCancelled, session?.user.id == userID else { return }
            if let deviceResponse { devices = deviceResponse.devices }
            if let connectionResponse { agentConnections = connectionResponse.connections }
            if let entitlementResponse { entitlement = entitlementResponse }
            if let modeResponse { pendingModeRequests = modeResponse.requests }
            await synchronizeNativeDisplays()
        } catch {
            guard !Task.isCancelled else { return }
            isLoadingLiveSurfaces = false
            errorMessage = friendlyMessage(error)
        }
    }

    func loadEvent(id: String) async throws -> EventDetail {
        if let userID = session?.user.id,
           let cached = privateEventStore.event(accountID: userID, eventID: id),
           let project = projects.first(where: { $0.id == cached.projectID }) {
            let referenceHash = SHA256.hash(data: Data(cached.reference.utf8))
                .map { String(format: "%02x", $0) }
                .joined()
            return EventDetail(
                id: cached.eventID,
                projectId: cached.projectID,
                eventType: cached.eventType,
                idempotencyKeyHash: referenceHash,
                data: cached.data,
                occurredAt: ISO8601DateFormatter.bellwire.string(from: cached.occurredAt),
                receivedAt: ISO8601DateFormatter.bellwire.string(from: cached.fetchedAt),
                status: "local",
                readAt: cached.readAt.map { ISO8601DateFormatter.bellwire.string(from: $0) },
                project: EventProject(
                    id: project.id,
                    name: project.name,
                    icon: project.icon,
                    logoUrl: cached.logoURL ?? project.logoUrl
                ),
                sensitiveFields: [],
                deliveries: []
            )
        }
        let detail: EventDetail = try await api.request("v1/events/\(id)")
        return detail
    }

    func loadProject(id: String) async throws -> (ProjectOverview, [InboxEvent]) {
        let overview: ProjectOverview = try await api.request("v1/projects/\(id)")
        let summary = ProjectSummary(
            id: overview.id,
            name: overview.name,
            slug: overview.slug,
            icon: overview.icon,
            logoUrl: overview.logoUrl,
            displayOrder: overview.displayOrder,
            category: overview.category,
            status: overview.status,
            deliveryMode: overview.deliveryMode,
            endpoint: overview.endpoint,
            createdAt: overview.createdAt,
            updatedAt: overview.updatedAt
        )
        let nextProjects = ProjectDataConsistency.mergeProjects(
            cloud: [summary],
            fallbacks: projects
        ).sorted(by: stableProjectOrder)
        let currentProjectSurfaces = overview.deliveryMode == .hosted
            ? overview.liveSurfaces
            : liveSurfaces.filter { $0.projectId == id }
        projects = nextProjects
        liveSurfaces = sortedSurfaces(
            liveSurfaces.filter { $0.projectId != id } + currentProjectSurfaces,
            projects: nextProjects
        )
        events = ProjectDataConsistency.normalizeEvents(events, projects: nextProjects)
        if overview.deliveryMode == .private {
            let privateEvents = session.map {
                privateEventStore.inboxEvents(accountID: $0.user.id, projects: [summary])
            } ?? []
            return (
                overview,
                Array(
                    ProjectDataConsistency.normalizeEvents(privateEvents, projects: [summary])
                        .prefix(30)
                )
            )
        }
        let page: EventPage = try await api.request("v1/projects/\(id)/events?limit=30")
        return (
            overview,
            ProjectDataConsistency.normalizeEvents(
                page.events.map { $0.inboxEvent(project: summary) },
                projects: [summary]
            )
        )
    }

    func exportProject(_ project: ProjectOverview) async throws -> URL {
        guard entitlement?.hasPro == true else {
            throw ProjectExportError.proRequired
        }
        let data: Data
        if project.deliveryMode == .private {
            guard let userID = session?.user.id else { throw ClientError.signedOut }
            let payload = PrivateProjectExport(
                version: 1,
                exportedAt: ISO8601DateFormatter.bellwire.string(from: .now),
                project: PrivateProjectExport.Project(
                    id: project.id,
                    name: project.name,
                    deliveryMode: "private"
                ),
                events: try privateEventStore.exportPayloads(
                    accountID: userID,
                    projectID: project.id
                )
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            data = try encoder.encode(payload)
        } else {
            data = try await api.requestData("v1/projects/\(project.id)/export")
        }

        let directory = FileManager.default.temporaryDirectory
            .appending(path: "BellwireExports", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let safeName = project.name
            .lowercased()
            .replacingOccurrences(
                of: #"[^a-z0-9_-]+"#,
                with: "-",
                options: .regularExpression
            )
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        let url = directory.appending(
            path: "\(safeName.isEmpty ? "project" : safeName)-bellwire-export.json"
        )
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        return url
    }

    func setProjectPaused(id: String, paused: Bool) async throws -> ProjectSummary {
        let updated: ProjectSummary = try await api.request(
            "v1/projects/\(id)",
            method: .patch,
            body: UpdateProjectPayload(status: paused ? "paused" : "active")
        )
        if let index = projects.firstIndex(where: { $0.id == id }) { projects[index] = updated }
        return updated
    }

    func deleteProject(id: String) async throws {
        try await api.requestVoid("v1/projects/\(id)", method: .delete)
        if let userID = session?.user.id {
            _ = try? keychain.deleteDirectConnection(projectID: id, userID: userID)
            try? privateEventStore.clear(accountID: userID, projectID: id)
        }
        projects.removeAll { $0.id == id }
        liveSurfaces.removeAll { $0.projectId == id }
        events.removeAll { $0.projectId == id }
        await synchronizeNativeDisplays()
    }

    private func stableProjectOrder(_ left: ProjectSummary, _ right: ProjectSummary) -> Bool {
        if left.displayOrder != right.displayOrder { return left.displayOrder < right.displayOrder }
        return left.id < right.id
    }

    private func deduplicatedSurfaces(_ values: [LiveSurfaceRecord]) -> [LiveSurfaceRecord] {
        var surfacesByKey: [String: LiveSurfaceRecord] = [:]
        for surface in values {
            surfacesByKey["\(surface.projectId):\(surface.surfaceKey)"] = surface
        }
        return Array(surfacesByKey.values)
    }

    private func sortedSurfaces(
        _ values: [LiveSurfaceRecord],
        projects: [ProjectSummary]
    ) -> [LiveSurfaceRecord] {
        let projectOrders = Dictionary(
            uniqueKeysWithValues: projects.map { ($0.id, $0.displayOrder) }
        )
        return ProjectDataConsistency.normalizeSurfaces(values, projects: projects).sorted { left, right in
            let leftProjectOrder = projectOrders[left.projectId] ?? Int.max
            let rightProjectOrder = projectOrders[right.projectId] ?? Int.max
            if leftProjectOrder != rightProjectOrder {
                return leftProjectOrder < rightProjectOrder
            }
            if left.displayOrder != right.displayOrder {
                return left.displayOrder < right.displayOrder
            }
            return left.id < right.id
        }
    }

    @discardableResult
    func deleteAccount() async -> Bool {
        errorMessage = nil
        do {
            let userID = session?.user.id
            try await api.requestVoid("v1/account", method: .delete)
            if let userID {
                keychain.deleteDirectData(userID: userID)
            }
            signOut()
            return true
        } catch {
            errorMessage = friendlyMessage(error)
            return false
        }
    }

    func createDemoExperience() async {
        guard !isCreatingDemo else { return }
        isCreatingDemo = true
        errorMessage = nil
        defer { isCreatingDemo = false }
        do {
            try await api.requestVoid("v1/demo", method: .post)
            await loadDashboard()
            BellwireHaptics.success()
        } catch {
            errorMessage = friendlyMessage(error)
        }
    }

    func submitAppleTransaction(
        _ signedTransactionInfo: String,
        source: String
    ) async throws -> AccountEntitlement {
        let value: AccountEntitlement = try await api.request(
            "v1/billing/apple/transactions",
            method: .post,
            body: AppleTransactionPayload(
                signedTransactionInfo: signedTransactionInfo,
                source: source
            )
        )
        entitlement = value
        await synchronizeNativeDisplays()
        return value
    }

    func captureProductEvent(_ event: String, source: String) async {
        try? await api.requestVoid(
            "v1/analytics/events",
            method: .post,
            body: ProductAnalyticsPayload(
                event: event,
                properties: ["source": source]
            )
        )
    }

    func refreshServerEntitlement() async throws -> AccountEntitlement {
        let value: AccountEntitlement = try await api.request("v1/account/entitlement")
        entitlement = value
        await synchronizeNativeDisplays()
        return value
    }

    func refreshPendingModeRequests() async {
        guard isAuthenticated else { return }
        do {
            let response: DeliveryModeChangeRequestsResponse = try await api.request(
                "v1/delivery-mode-requests?status=pending"
            )
            pendingModeRequests = response.requests
            let pendingIDs = Set(response.requests.map(\.id))
            modeRequestErrors = modeRequestErrors.filter { pendingIDs.contains($0.key) }
        } catch {
            errorMessage = friendlyMessage(error)
        }
    }

    func resolveModeRequest(id: String, approve: Bool) async {
        guard resolvingModeRequestID == nil else { return }
        resolvingModeRequestID = id
        modeRequestErrors.removeValue(forKey: id)
        defer { resolvingModeRequestID = nil }
        do {
            let _: DeliveryModeChangeRequest = try await api.request(
                "v1/delivery-mode-requests/\(id)/\(approve ? "approve" : "reject")",
                method: .post
            )
            pendingModeRequests.removeAll { $0.id == id }
            await loadDashboard()
            BellwireHaptics.success()
        } catch {
            if case ClientError.api(let code, _) = error,
               code == "PRIVATE_READINESS_REQUIRED" {
                modeRequestErrors[id] = String(
                    localized: "Finish the Direct connection on this iPhone before enabling Private delivery."
                )
            } else {
                modeRequestErrors[id] = friendlyMessage(error)
            }
            BellwireHaptics.error()
        }
    }

    func deleteDevice(id: String) async {
        do {
            try await api.requestVoid("v1/devices/\(id)", method: .delete)
            devices.removeAll { $0.id == id }
            await refreshServerEntitlementIfPossible()
            BellwireHaptics.success()
        } catch {
            errorMessage = friendlyMessage(error)
            BellwireHaptics.error()
        }
    }

    private func refreshServerEntitlementIfPossible() async {
        if let value: AccountEntitlement = try? await api.request("v1/account/entitlement") {
            entitlement = value
            await synchronizeNativeDisplays()
        }
    }

    func clearPrivateHistory() {
        guard let userID = session?.user.id else { return }
        do {
            try privateEventStore.clear(accountID: userID)
            events.removeAll { $0.id.hasPrefix("private:") }
            BellwireHaptics.success()
        } catch {
            errorMessage = friendlyMessage(error)
        }
    }

    func markRead(id: String) async {
        guard let index = events.firstIndex(where: { $0.id == id }), events[index].isUnread else { return }
        do {
            let readAt: String
            if id.hasPrefix("private:"), let userID = session?.user.id {
                let date = Date()
                _ = try privateEventStore.markRead(accountID: userID, eventID: id, at: date)
                readAt = ISO8601DateFormatter.bellwire.string(from: date)
            } else {
                let response: ReadResponse = try await api.request(
                    "v1/events/\(id)/read",
                    method: .post
                )
                readAt = response.readAt
            }
            let old = events[index]
            events[index] = InboxEvent(
                id: old.id,
                projectId: old.projectId,
                eventType: old.eventType,
                data: old.data,
                occurredAt: old.occurredAt,
                receivedAt: old.receivedAt,
                status: old.status,
                readAt: readAt,
                project: old.project,
                sensitiveFields: old.sensitiveFields
            )
        } catch {
            errorMessage = friendlyMessage(error)
        }
    }

    @discardableResult
    func markAllRead() async -> Int {
        guard unreadCount > 0, !isMarkingAllRead else { return 0 }
        isMarkingAllRead = true
        defer { isMarkingAllRead = false }
        do {
            let response: ReadAllResponse = try await api.request("v1/inbox/read-all", method: .post)
            let localCount: Int
            if let userID = session?.user.id {
                localCount = try privateEventStore.markAllRead(accountID: userID)
            } else {
                localCount = 0
            }
            let readAt = ISO8601DateFormatter.bellwire.string(from: .now)
            events = events.map { event in
                guard event.isUnread else { return event }
                return InboxEvent(
                    id: event.id,
                    projectId: event.projectId,
                    eventType: event.eventType,
                    data: event.data,
                    occurredAt: event.occurredAt,
                    receivedAt: event.receivedAt,
                    status: event.status,
                    readAt: event.id.hasPrefix("private:") ? readAt : response.readAt,
                    project: event.project,
                    sensitiveFields: event.sensitiveFields
                )
            }
            return response.updatedCount + localCount
        } catch {
            errorMessage = friendlyMessage(error)
            return 0
        }
    }

    func createBinding() async {
        errorMessage = nil
        do {
            guard let userID = session?.user.id else { throw ClientError.signedOut }
            struct Payload: Encodable {
                let deviceKey: DeviceKeyDescriptor
            }
            let installationID = try keychain.installationID()
            let identity = try keychain.deviceIdentity(userID: userID)
            let response: BindingResponse = try await api.request(
                "v1/device-bindings",
                method: .post,
                body: Payload(deviceKey: identity.descriptor(installationID: installationID))
            )
            binding = response
        } catch {
            errorMessage = friendlyMessage(error)
        }
    }

    func revokeAgentConnection(id: String) async {
        guard revokingAgentConnectionID == nil else { return }
        revokingAgentConnectionID = id
        defer { revokingAgentConnectionID = nil }
        do {
            try await api.requestVoid("v1/agent-connections/\(id)", method: .delete)
            withAnimation(BellwireAnimation.standard) {
                agentConnections.removeAll { $0.id == id }
            }
            BellwireHaptics.success()
        } catch {
            errorMessage = friendlyMessage(error)
        }
    }

    @discardableResult
    func requestNotificationPermission() async -> Bool {
        errorMessage = nil
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .badge, .sound])
            await refreshNotificationStatus()
            if granted { UIApplication.shared.registerForRemoteNotifications() }
            return true
        } catch {
            errorMessage = "Notification permission could not be requested."
            return false
        }
    }

    func refreshNotificationStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined:
            notificationPermission = .notDetermined
            notificationAuthorizationDiagnostic = "not_determined"
        case .denied:
            notificationPermission = .denied
            notificationAuthorizationDiagnostic = "denied"
        case .authorized:
            notificationPermission = .authorized
            notificationAuthorizationDiagnostic = "authorized"
        case .provisional:
            notificationPermission = .authorized
            notificationAuthorizationDiagnostic = "provisional"
        case .ephemeral:
            notificationPermission = .authorized
            notificationAuthorizationDiagnostic = "ephemeral"
        @unknown default:
            notificationPermission = .unknown
            notificationAuthorizationDiagnostic = "unknown"
        }
    }

    func receivedAPNsToken(_ token: String) async {
        apnsToken = token
        guard isAuthenticated else { return }
        await registerDevice(token)
    }

    func handleDeepLink(_ url: URL) {
        guard url.scheme == AppConfig.urlScheme else { return }
        if url.host == "settings",
           url.pathComponents.dropFirst().first == "mode-requests" {
            pendingModeRequestNavigation = true
            Task { @MainActor [weak self] in
                await self?.refreshPendingModeRequests()
            }
            return
        }
        if url.host == "events" {
            let id = url.pathComponents.dropFirst().first
            if let id, !id.isEmpty { pendingEventID = id }
            return
        }
        guard url.host == "private" else { return }
        let components = Array(url.pathComponents.dropFirst())
        guard components.count == 2 else { return }
        Task { @MainActor [weak self] in
            await self?.openPrivateNotification(
                projectID: components[0],
                reference: components[1]
            )
        }
    }

    func handleRemoteNotification(deepLink: URL? = nil) {
        if let deepLink { handleDeepLink(deepLink) }
        guard isAuthenticated else { return }
        Task { @MainActor [weak self] in
            await self?.loadDashboard()
        }
    }

    private func openPrivateNotification(projectID: String, reference: String) async {
        guard let userID = session?.user.id,
              reference.range(
                of: #"^[A-Za-z0-9_-]{22,200}$"#,
                options: .regularExpression
              ) != nil,
              let manifest = keychain.directConnectionManifests(userID: userID)
                .first(where: { $0.project.id == projectID }),
              let identity = try? keychain.deviceIdentity(userID: userID),
              let url = manifest.notificationURL(reference: reference),
              let request = signedDirectRequest(
                url: url,
                identity: identity,
                connectionID: manifest.connectionId,
                timeout: 8
              )
        else { return }
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  data.count <= 64 * 1_024
            else { throw DirectConnectionError.invalidResponse }
            let payload = try JSONDecoder().decode(PrivateEventPayload.self, from: data)
            guard payload.reference == reference, privatePayloadIsValid(payload) else {
                throw DirectConnectionError.invalidResponse
            }
            try privateEventStore.merge(
                accountID: userID,
                projectID: projectID,
                payloads: [payload]
            )
            let hosted = events.filter { !$0.id.hasPrefix("private:") }
            events = (hosted + privateEventStore.inboxEvents(accountID: userID, projects: projects))
                .sorted { $0.receivedAt > $1.receivedAt }
            pendingEventID = "private:\(projectID):\(reference)"
            privateLastSyncAt[projectID] = .now
            privateSyncErrors.removeValue(forKey: projectID)
        } catch {
            privateSyncErrors[projectID] = friendlyMessage(error)
        }
    }

    func signOut() {
        if let refreshToken = session?.refreshToken {
            let client = api
            Task { try? await client.revokeSession(refreshToken) }
        }
        dashboardLoadTask?.cancel()
        sessionRefreshTask?.cancel()
        liveActivityUpdatesTask?.cancel()
        pushToStartTokenTask?.cancel()
        observedLiveActivityTasks.values.forEach { $0.cancel() }
        dashboardLoadTask = nil
        dashboardLoadID = nil
        sessionRefreshTask = nil
        liveActivityUpdatesTask = nil
        pushToStartTokenTask = nil
        observedLiveActivityTasks = [:]
        pushToStartToken = nil
        if let userID = session?.user.id {
            keychain.deleteDirectData(userID: userID)
            try? privateEventStore.clear(accountID: userID)
        }
        keychain.delete()
        keychain.deleteDirectNotificationContext()
        session = nil
        projects = []
        liveSurfaces = []
        events = []
        devices = []
        agentConnections = []
        entitlement = nil
        pendingModeRequests = []
        resolvingModeRequestID = nil
        modeRequestErrors = [:]
        privateSyncErrors = [:]
        privateLastSyncAt = [:]
        revokingAgentConnectionID = nil
        binding = nil
        pendingEventID = nil
        pendingModeRequestNavigation = false
        lastDashboardRefreshAt = nil
        isLoading = false
        isLoadingLiveSurfaces = false
        hasCompletedInitialDashboardLoad = false
        hasLoadedDashboardSuccessfully = false
        Task { await NativeDisplayManager.shared.clear() }
    }

    func startLiveActivity(for surface: LiveSurfaceRecord) async throws {
        guard entitlement?.hasPro == true else {
            throw ProjectExportError.proRequired
        }
        try await NativeDisplayManager.shared.startLiveActivity(for: surface)
    }

    func stopLiveActivity(surfaceID: String) async {
        await NativeDisplayManager.shared.stopLiveActivity(surfaceID: surfaceID)
    }

    func isLiveActivityActive(surfaceID: String) -> Bool {
        NativeDisplayManager.shared.isLive(surfaceID: surfaceID)
    }

    func setAgentLiveActivitiesEnabled(_ enabled: Bool) async {
        await NativeDisplayManager.shared.setAgentLiveActivitiesEnabled(enabled)
        await publishLiveActivityCapability()
        await synchronizeNativeDisplays()
    }

    private func synchronizeNativeDisplays() async {
        await NativeDisplayManager.shared.synchronize(
            surfaces: liveSurfaces,
            projects: projects,
            isPro: entitlement?.hasPro == true
        )
    }

    private func registerDevice(_ token: String) async {
        struct Payload: Encodable {
            let name: String
            let apnsToken: String
            let apnsEnvironment: String
            let appVersion: String
            let buildNumber: String
            let notificationAuthorization: String
            let installationId: String
        }
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        let buildNumber = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
#if DEBUG
        let environment = "sandbox"
#else
        let environment = "production"
#endif
        do {
            let installationId = try keychain.installationID()
            let _: DeviceRecord = try await api.request(
                "v1/devices",
                method: .post,
                body: Payload(
                    name: UIDevice.current.name,
                    apnsToken: token,
                    apnsEnvironment: environment,
                    appVersion: version,
                    buildNumber: buildNumber,
                    notificationAuthorization: notificationAuthorizationDiagnostic,
                    installationId: installationId
                )
            )
            let response: DevicesResponse = try await api.request("v1/devices")
            devices = response.devices
            await publishLiveActivityCapability()
        } catch {
            errorMessage = friendlyMessage(error)
        }
    }

    private func startLiveActivityObservers() {
        guard liveActivityUpdatesTask == nil else { return }
        for activity in Activity<BellwireActivityAttributes>.activities {
            observeLiveActivity(activity)
        }
        liveActivityUpdatesTask = Task { @MainActor [weak self] in
            for await activity in Activity<BellwireActivityAttributes>.activityUpdates {
                guard !Task.isCancelled else { return }
                self?.observeLiveActivity(activity)
            }
        }
        if #available(iOS 17.2, *) {
            pushToStartTokenTask = Task { @MainActor [weak self] in
                for await token in Activity<BellwireActivityAttributes>.pushToStartTokenUpdates {
                    guard !Task.isCancelled else { return }
                    self?.pushToStartToken = token.hexString
                    await self?.publishLiveActivityCapability()
                }
            }
        }
    }

    private func observeLiveActivity(_ activity: Activity<BellwireActivityAttributes>) {
        guard UserDefaults.standard.bool(forKey: "agentLiveActivitiesEnabled") else {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
            return
        }
        guard activity.attributes.origin == "agent",
              activity.attributes.deliveryMode == "hosted",
              activity.attributes.projectID != nil,
              activity.attributes.sessionID != nil,
              observedLiveActivityTasks[activity.id] == nil
        else { return }
        observedLiveActivityTasks[activity.id] = Task { @MainActor [weak self] in
            for await token in activity.pushTokenUpdates {
                guard !Task.isCancelled else { return }
                await self?.registerLiveActivity(activity, updateToken: token.hexString)
            }
            await self?.removeLiveActivityRegistration(activityID: activity.id)
            self?.observedLiveActivityTasks.removeValue(forKey: activity.id)
        }
    }

    private func publishLiveActivityCapability() async {
        guard isAuthenticated, let installationId = try? keychain.installationID() else { return }
        struct Payload: Encodable {
            let installationId: String
            let activitiesEnabled: Bool
            let autoStartEnabled: Bool
            let pushToStartToken: String?
            let osVersion: String
        }
        let consent = UserDefaults.standard.bool(forKey: "agentLiveActivitiesEnabled")
        try? await api.requestVoid(
            "v1/devices/live-activity-capability",
            method: .put,
            body: Payload(
                installationId: installationId,
                activitiesEnabled: ActivityAuthorizationInfo().areActivitiesEnabled,
                autoStartEnabled: consent,
                pushToStartToken: pushToStartToken,
                osVersion: UIDevice.current.systemVersion
            )
        )
    }

    private func registerLiveActivity(
        _ activity: Activity<BellwireActivityAttributes>,
        updateToken: String
    ) async {
        guard let projectId = activity.attributes.projectID,
              let sessionId = activity.attributes.sessionID,
              let installationId = try? keychain.installationID()
        else { return }
        struct Payload: Encodable {
            let installationId: String
            let projectId: String
            let surfaceId: String
            let sessionId: String
            let updateToken: String
            let apnsEnvironment: String
        }
#if DEBUG
        let environment = "sandbox"
#else
        let environment = "production"
#endif
        try? await api.requestVoid(
            "v1/live-activities/\(activity.id)",
            method: .put,
            body: Payload(
                installationId: installationId,
                projectId: projectId,
                surfaceId: activity.attributes.surfaceID,
                sessionId: sessionId,
                updateToken: updateToken,
                apnsEnvironment: environment
            )
        )
    }

    private func removeLiveActivityRegistration(activityID: String) async {
        try? await api.requestVoid("v1/live-activities/\(activityID)", method: .delete)
    }

    private func validAccessToken() async throws -> String {
        guard let current = session else { throw ClientError.signedOut }
        guard current.needsRefresh else { return current.accessToken }
        if let sessionRefreshTask {
            return try await sessionRefreshTask.value.accessToken
        }

        let refreshToken = current.refreshToken
        let client = api
        let task = Task { try await client.refreshSession(refreshToken) }
        sessionRefreshTask = task
        do {
            let refreshed = try await task.value
            sessionRefreshTask = nil
            guard session?.refreshToken == refreshToken else { throw ClientError.signedOut }
            try saveSession(refreshed)
            return refreshed.accessToken
        } catch {
            sessionRefreshTask = nil
            throw error
        }
    }

    private func saveSession(_ value: AuthSession) throws {
        if session?.user.id != value.user.id {
            hasCompletedInitialDashboardLoad = false
            hasLoadedDashboardSuccessfully = false
        }
        try keychain.save(value)
        session = value
    }

    private func refreshDirectConnections(userID: String) async {
        guard let identity = try? keychain.deviceIdentity(userID: userID) else { return }
        var manifests = keychain.directConnectionManifests(userID: userID)
        if let response: DirectConnectionEnvelopesResponse = try? await api.request(
            "v1/direct-connections?deviceKeyId=\(identity.id)"
        ) {
            for envelope in response.envelopes where envelope.deviceKeyId == identity.id {
                guard let plaintext = try? identity.decrypt(envelope),
                      let manifest = try? JSONDecoder().decode(
                        DirectConnectionManifest.self,
                        from: plaintext
                      ),
                      manifest.version == 2,
                      manifest.project.id == envelope.projectId,
                      envelope.manifestVersion == 2,
                      manifest.surfacesURL != nil,
                      manifest.inboxURL() != nil,
                      manifest.capabilities.contains("surfaces"),
                      manifest.capabilities.contains("inbox")
                else { continue }
                manifests.removeAll {
                    $0.project.id == manifest.project.id || $0.connectionId == manifest.connectionId
                }
                manifests.append(manifest)
                do {
                    try keychain.saveDirectConnectionManifests(manifests, userID: userID)
                    try keychain.saveDirectNotificationContext(
                        manifests: manifests,
                        identity: identity
                    )
                    try await api.requestVoid(
                        "v1/direct-connections/\(envelope.id)/ack",
                        method: .post,
                        body: DirectConnectionAckPayload(deviceKeyId: identity.id)
                    )
                } catch {
                    continue
                }
            }
        }

        try? keychain.saveDirectNotificationContext(
            manifests: manifests,
            identity: identity
        )

        for manifest in manifests {
            guard projects.contains(where: {
                $0.id == manifest.project.id && $0.deliveryMode == .private
            }) else { continue }
            do {
                async let directSurfaces = fetchDirectSurfaces(
                    manifest: manifest,
                    identity: identity
                )
                async let inboxPayloads = fetchDirectInbox(
                    manifest: manifest,
                    identity: identity
                )
                let (surfaces, payloads) = try await (directSurfaces, inboxPayloads)
                try privateEventStore.merge(
                    accountID: userID,
                    projectID: manifest.project.id,
                    payloads: payloads
                )
                let nextSurfaces = deduplicatedSurfaces(
                    liveSurfaces.filter { $0.projectId != manifest.project.id } + surfaces
                )
                liveSurfaces = sortedSurfaces(nextSurfaces, projects: projects)
                privateLastSyncAt[manifest.project.id] = .now
                privateSyncErrors.removeValue(forKey: manifest.project.id)
            } catch {
                privateSyncErrors[manifest.project.id] = friendlyMessage(error)
            }
        }
        let hostedEvents = events.filter { !$0.id.hasPrefix("private:") }
        events = ProjectDataConsistency.normalizeEvents(
            hostedEvents + privateEventStore.inboxEvents(accountID: userID, projects: projects),
            projects: projects
        )
            .sorted { $0.receivedAt > $1.receivedAt }
    }

    private func registerCurrentDeviceKey(userID: String) async throws {
        let installationID = try keychain.installationID()
        let identity = try keychain.deviceIdentity(userID: userID)
        try await api.requestVoid(
            "v1/device-keys",
            method: .post,
            body: identity.descriptor(installationID: installationID)
        )
    }

    private func requestDirectConnectionRecovery(
        project: ProjectSummary,
        userID: String
    ) async {
        guard let identity = try? keychain.deviceIdentity(userID: userID),
              let installationId = try? keychain.installationID()
        else { return }
        struct Payload: Encodable {
            let deviceKeyId: String
            let installationId: String
            let appVersion: String
            let buildNumber: String
            let notificationAuthorization: String
        }
        let appVersion = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
        ) as? String ?? "unknown"
        let buildNumber = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleVersion"
        ) as? String ?? "unknown"
        try? await api.requestVoid(
            "v1/projects/\(project.id)/direct-connection-recovery",
            method: .post,
            body: Payload(
                deviceKeyId: identity.id,
                installationId: installationId,
                appVersion: appVersion,
                buildNumber: buildNumber,
                notificationAuthorization: notificationAuthorizationDiagnostic
            )
        )
    }

    private func fetchDirectSurfaces(
        manifest: DirectConnectionManifest,
        identity: DeviceIdentity
    ) async throws -> [LiveSurfaceRecord] {
        guard let url = manifest.surfacesURL else {
            throw DirectConnectionError.invalidManifest
        }
        guard let request = signedDirectRequest(
            url: url,
            identity: identity,
            connectionID: manifest.connectionId
        ) else { throw DirectConnectionError.invalidManifest }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              data.count <= 1_048_576
        else { throw DirectConnectionError.invalidResponse }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let payload = try decoder.decode(LiveSurfacesResponse.self, from: data)
        guard payload.surfaces.allSatisfy({ $0.projectId == manifest.project.id }) else {
            throw DirectConnectionError.invalidResponse
        }
        return payload.surfaces
    }

    private func fetchDirectInbox(
        manifest: DirectConnectionManifest,
        identity: DeviceIdentity
    ) async throws -> [PrivateEventPayload] {
        var cursor: String?
        var payloads: [PrivateEventPayload] = []
        for _ in 0..<10 {
            guard let url = manifest.inboxURL(cursor: cursor),
                  let request = signedDirectRequest(
                    url: url,
                    identity: identity,
                    connectionID: manifest.connectionId
                  )
            else { throw DirectConnectionError.invalidManifest }
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  data.count <= 1_048_576
            else { throw DirectConnectionError.invalidResponse }
            let page = try JSONDecoder().decode(PrivateInboxPage.self, from: data)
            guard page.events.count <= 50,
                  page.events.allSatisfy({ privatePayloadIsValid($0) })
            else { throw DirectConnectionError.invalidResponse }
            payloads.append(contentsOf: page.events)
            guard let next = page.nextCursor, !next.isEmpty, next != cursor else { break }
            cursor = next
        }
        return payloads
    }

    private func signedDirectRequest(
        url: URL,
        identity: DeviceIdentity,
        connectionID: String,
        timeout: TimeInterval = 15
    ) -> URLRequest? {
        let timestamp = String(Int(Date().timeIntervalSince1970))
        let nonce = randomNonce()
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let path = (components?.percentEncodedPath.isEmpty == false
            ? components?.percentEncodedPath
            : "/") ?? "/"
        let target = components?.percentEncodedQuery.map { "\(path)?\($0)" } ?? path
        let emptyHash = SHA256.hash(data: Data())
            .map { String(format: "%02x", $0) }
            .joined()
        let canonical = ["GET", target, timestamp, nonce, emptyHash].joined(separator: "\n")
        guard let signature = try? identity.signature(for: Data(canonical.utf8)) else {
            return nil
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(Locale.preferredLanguages.first ?? "en", forHTTPHeaderField: "Accept-Language")
        request.setValue(connectionID, forHTTPHeaderField: "X-Bellwire-Connection")
        request.setValue(identity.id, forHTTPHeaderField: "X-Bellwire-Key-Id")
        request.setValue(timestamp, forHTTPHeaderField: "X-Bellwire-Timestamp")
        request.setValue(nonce, forHTTPHeaderField: "X-Bellwire-Nonce")
        request.setValue(signature, forHTTPHeaderField: "X-Bellwire-Signature")
        return request
    }

    private func privatePayloadIsValid(_ payload: PrivateEventPayload) -> Bool {
        payload.reference.range(
            of: #"^[A-Za-z0-9_-]{22,200}$"#,
            options: .regularExpression
        ) != nil
            && !payload.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && payload.title.count <= 240
            && !payload.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && payload.body.count <= 1_000
            && (payload.subtitle?.count ?? 0) <= 240
            && ISO8601DateFormatter.bellwireDate(from: payload.occurredAt) != nil
            && validOptionalHTTPSURL(payload.logoUrl)
            && validOptionalDeepLink(payload.deepLink)
    }

    private func validOptionalHTTPSURL(_ value: String?) -> Bool {
        guard let value else { return true }
        guard let url = URL(string: value) else { return false }
        return url.scheme?.lowercased() == "https"
            && url.user == nil
            && url.password == nil
            && url.host != nil
    }

    private func validOptionalDeepLink(_ value: String?) -> Bool {
        guard let value else { return true }
        guard let url = URL(string: value), let scheme = url.scheme?.lowercased() else {
            return false
        }
        return scheme == "https" || scheme == "bellwire"
    }

    private func friendlyMessage(_ error: Error) -> String {
        if let localized = error as? LocalizedError, let description = localized.errorDescription {
            return description
        }
        return "Connection failed. Please try again."
    }

    private func randomNonce(length: Int = 32) -> String {
        precondition(length > 0)
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var result = ""
        var remaining = length
        while remaining > 0 {
            var bytes = [UInt8](repeating: 0, count: 16)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
                return UUID().uuidString.replacingOccurrences(of: "-", with: "")
            }
            for byte in bytes where remaining > 0 {
                if byte < charset.count {
                    result.append(charset[Int(byte)])
                    remaining -= 1
                }
            }
        }
        return result
    }
}

private struct PrivateProjectExport: Encodable {
    struct Project: Encodable {
        let id: String
        let name: String
        let deliveryMode: String
    }

    let version: Int
    let exportedAt: String
    let project: Project
    let events: [PrivateEventPayload]
}

private enum ProjectExportError: LocalizedError {
    case proRequired

    var errorDescription: String? {
        String(localized: "Project export is included with Bellwire Pro.")
    }
}

private extension Data {
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
