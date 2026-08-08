// SPDX-License-Identifier: MPL-2.0
import Foundation
import SwiftUI

struct AuthSession: Codable, Equatable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: Date
    let user: AuthUser
    let issuer: String?

    init(
        accessToken: String,
        refreshToken: String,
        expiresAt: Date,
        user: AuthUser,
        issuer: String? = nil
    ) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
        self.user = user
        self.issuer = issuer
    }

    var needsRefresh: Bool {
        expiresAt.timeIntervalSinceNow < 120
    }
}

struct AuthUser: Codable, Equatable {
    let id: String
    let email: String?
}

struct AuthTokenResponse: Decodable {
    let accessToken: String
    let refreshToken: String
    let expiresIn: TimeInterval
    let user: AuthUser

    func session(now: Date = .now, issuer: String? = nil) -> AuthSession {
        AuthSession(
            accessToken: accessToken,
            refreshToken: refreshToken,
            expiresAt: now.addingTimeInterval(expiresIn),
            user: user,
            issuer: issuer
        )
    }
}

struct ProjectSummary: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let slug: String
    let icon: String
    let logoUrl: String?
    let displayOrder: Int
    let category: String
    let status: String
    let deliveryMode: ProjectDeliveryMode
    let endpoint: String
    let createdAt: String
    let updatedAt: String

    var isPaused: Bool { status == "paused" }
    var isPrivate: Bool { deliveryMode == .private }
}

enum ProjectDeliveryMode: String, Codable {
    case `private`
    case hosted
}

struct ProjectsResponse: Decodable {
    let projects: [ProjectSummary]
}

struct InboxResponse: Decodable {
    let events: [InboxEvent]
}

struct EventPage: Decodable {
    let events: [InboxEventWithoutProject]
    let nextCursor: String?
}

struct InboxEventWithoutProject: Decodable, Identifiable {
    let id: String
    let projectId: String
    let eventType: String
    let data: [String: JSONValue]
    let occurredAt: String
    let receivedAt: String
    let status: String
    let readAt: String?
    let sensitiveFields: [String]

    private enum CodingKeys: String, CodingKey {
        case id, projectId, eventType, data, occurredAt, receivedAt, status, readAt, sensitiveFields
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        projectId = try container.decode(String.self, forKey: .projectId)
        eventType = try container.decode(String.self, forKey: .eventType)
        data = try container.decode([String: JSONValue].self, forKey: .data)
        occurredAt = try container.decode(String.self, forKey: .occurredAt)
        receivedAt = try container.decode(String.self, forKey: .receivedAt)
        status = try container.decode(String.self, forKey: .status)
        readAt = try container.decodeIfPresent(String.self, forKey: .readAt)
        sensitiveFields = (try? container.decode([String].self, forKey: .sensitiveFields))
            ?? Array(data.keys)
    }

    func inboxEvent(project: ProjectSummary) -> InboxEvent {
        InboxEvent(
            id: id,
            projectId: projectId,
            eventType: eventType,
            data: data,
            occurredAt: occurredAt,
            receivedAt: receivedAt,
            status: status,
            readAt: readAt,
            project: EventProject(id: project.id, name: project.name, icon: project.icon, logoUrl: project.logoUrl),
            sensitiveFields: sensitiveFields
        )
    }
}

struct ProjectOverview: Decodable, Identifiable {
    let id: String
    let name: String
    let slug: String
    let icon: String
    let logoUrl: String?
    let displayOrder: Int
    let category: String
    let status: String
    let deliveryMode: ProjectDeliveryMode
    let endpoint: String
    let createdAt: String
    let updatedAt: String
    let eventSchemas: [EventSchemaSummary]
    let notificationSurfaces: [NotificationSurfaceSummary]
    let liveSurfaces: [LiveSurfaceRecord]
    let deliveryHealth: DeliveryHealth
    let privateReadiness: PrivateReadinessSummary
}

extension ProjectOverview {
    func resolvingDetailLiveSurfaces(
        from directSurfaces: [LiveSurfaceRecord]
    ) -> ProjectOverview {
        guard deliveryMode == .private else { return self }
        return ProjectOverview(
            id: id,
            name: name,
            slug: slug,
            icon: icon,
            logoUrl: logoUrl,
            displayOrder: displayOrder,
            category: category,
            status: status,
            deliveryMode: deliveryMode,
            endpoint: endpoint,
            createdAt: createdAt,
            updatedAt: updatedAt,
            eventSchemas: eventSchemas,
            notificationSurfaces: notificationSurfaces,
            liveSurfaces: directSurfaces.filter { $0.projectId == id },
            deliveryHealth: deliveryHealth,
            privateReadiness: privateReadiness
        )
    }
}

struct PrivateReadinessSummary: Decodable {
    let readyDevices: Int
    let activeDevices: Int
    let connections: [PrivateConnectionReadiness]
}

struct PrivateConnectionReadiness: Decodable, Identifiable {
    let projectId: String
    let deviceKeyId: String
    let readyAt: String
    let lastVerifiedAt: String
    let lastSyncAt: String?
    let lastErrorCode: String?

    var id: String { "\(projectId):\(deviceKeyId)" }
}

struct EventSchemaSummary: Decodable, Identifiable {
    let id: String
    let eventType: String
    let version: Int
}

struct NotificationSurfaceSummary: Decodable, Identifiable {
    let id: String
    let eventType: String
    let priority: String
    let enabled: Bool
    let version: Int
}

struct LiveSurfacesResponse: Decodable {
    let surfaces: [LiveSurfaceRecord]
}

struct LiveSurfaceRecord: Decodable, Identifiable, Hashable {
    let id: String
    let projectId: String
    let surfaceKey: String
    let type: String
    let title: String
    let subtitle: String?
    let content: [String: JSONValue]
    let action: LiveSurfaceAction?
    var liveActivity: LiveActivityDirective? = nil
    let displayOrder: Int
    let version: Int
    let createdAt: String
    let updatedAt: String
    let project: EventProject?

    var updatedDate: Date? { ISO8601DateFormatter.bellwireDate(from: updatedAt) }
}

struct LiveActivityDirective: Decodable, Hashable {
    let sessionId: String
    let state: String
}

struct LiveSurfaceAction: Decodable, Hashable {
    let type: String
    let title: String
    let url: String
}

struct LiveSurfaceMetric: Hashable {
    let label: String
    let value: JSONValue
    let unit: String?
    let color: String?
}

extension LiveSurfaceRecord {
    var metrics: [LiveSurfaceMetric] {
        guard let values = content["metrics"]?.arrayValue else { return [] }
        return values.compactMap { value in
            guard let object = value.objectValue,
                  let label = object["label"]?.stringValue,
                  let metricValue = object["value"]
            else { return nil }
            return LiveSurfaceMetric(
                label: label,
                value: metricValue,
                unit: object["unit"]?.stringValue,
                color: object["color"]?.stringValue
            )
        }
    }
}

struct DeliveryHealth: Decodable {
    let queued: Int
    let accepted: Int
    let failed: Int
    let status: String
}

struct InboxEvent: Codable, Identifiable, Hashable {
    let id: String
    let projectId: String
    let eventType: String
    let data: [String: JSONValue]
    let occurredAt: String
    let receivedAt: String
    let status: String
    let readAt: String?
    let project: EventProject
    let sensitiveFields: [String]

    init(
        id: String,
        projectId: String,
        eventType: String,
        data: [String: JSONValue],
        occurredAt: String,
        receivedAt: String,
        status: String,
        readAt: String?,
        project: EventProject,
        sensitiveFields: [String]
    ) {
        self.id = id
        self.projectId = projectId
        self.eventType = eventType
        self.data = data
        self.occurredAt = occurredAt
        self.receivedAt = receivedAt
        self.status = status
        self.readAt = readAt
        self.project = project
        self.sensitiveFields = sensitiveFields
    }

    private enum CodingKeys: String, CodingKey {
        case id, projectId, eventType, data, occurredAt, receivedAt, status, readAt, project, sensitiveFields
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        projectId = try container.decode(String.self, forKey: .projectId)
        eventType = try container.decode(String.self, forKey: .eventType)
        data = try container.decode([String: JSONValue].self, forKey: .data)
        occurredAt = try container.decode(String.self, forKey: .occurredAt)
        receivedAt = try container.decode(String.self, forKey: .receivedAt)
        status = try container.decode(String.self, forKey: .status)
        readAt = try container.decodeIfPresent(String.self, forKey: .readAt)
        project = try container.decode(EventProject.self, forKey: .project)
        sensitiveFields = (try? container.decode([String].self, forKey: .sensitiveFields))
            ?? Array(data.keys)
    }

    var isUnread: Bool { readAt == nil }
    var receivedDate: Date? { ISO8601DateFormatter.bellwireDate(from: receivedAt) }
    var displayTitle: String { eventType.humanizedEventType }

    var preview: String {
        let sensitive = Set(sensitiveFields)
        let safeData = data.filter { !sensitive.contains($0.key) }
        let preferred = ["amount", "product", "message", "status", "currency"]
        let values = preferred.compactMap { safeData[$0]?.displayValue }.filter { !$0.isEmpty }
        if !values.isEmpty { return values.prefix(2).joined(separator: " · ") }
        return safeData.keys.sorted().compactMap { safeData[$0]?.displayValue }.prefix(2).joined(separator: " · ")
    }
}

struct EventProject: Codable, Hashable {
    let id: String
    let name: String
    let icon: String
    let logoUrl: String?
}

struct EventDetail: Decodable, Identifiable {
    let id: String
    let projectId: String
    let eventType: String
    let idempotencyKeyHash: String?
    let data: [String: JSONValue]
    let occurredAt: String
    let receivedAt: String
    let status: String
    let readAt: String?
    let project: EventProject
    let sensitiveFields: [String]
    let deliveries: [DeliveryRecord]

    init(
        id: String,
        projectId: String,
        eventType: String,
        idempotencyKeyHash: String?,
        data: [String: JSONValue],
        occurredAt: String,
        receivedAt: String,
        status: String,
        readAt: String?,
        project: EventProject,
        sensitiveFields: [String],
        deliveries: [DeliveryRecord]
    ) {
        self.id = id
        self.projectId = projectId
        self.eventType = eventType
        self.idempotencyKeyHash = idempotencyKeyHash
        self.data = data
        self.occurredAt = occurredAt
        self.receivedAt = receivedAt
        self.status = status
        self.readAt = readAt
        self.project = project
        self.sensitiveFields = sensitiveFields
        self.deliveries = deliveries
    }

    private enum CodingKeys: String, CodingKey {
        case id, projectId, eventType, idempotencyKeyHash, data, occurredAt, receivedAt
        case status, readAt, project, sensitiveFields, deliveries
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        projectId = try container.decode(String.self, forKey: .projectId)
        eventType = try container.decode(String.self, forKey: .eventType)
        idempotencyKeyHash = try container.decodeIfPresent(String.self, forKey: .idempotencyKeyHash)
        data = try container.decode([String: JSONValue].self, forKey: .data)
        occurredAt = try container.decode(String.self, forKey: .occurredAt)
        receivedAt = try container.decode(String.self, forKey: .receivedAt)
        status = try container.decode(String.self, forKey: .status)
        readAt = try container.decodeIfPresent(String.self, forKey: .readAt)
        project = try container.decode(EventProject.self, forKey: .project)
        sensitiveFields = (try? container.decode([String].self, forKey: .sensitiveFields))
            ?? Array(data.keys)
        deliveries = try container.decode([DeliveryRecord].self, forKey: .deliveries)
    }

    var occurredDate: Date? { ISO8601DateFormatter.bellwireDate(from: occurredAt) }
}

struct DeliveryRecord: Decodable, Identifiable {
    let id: String
    let deviceId: String
    let status: String
    let attemptCount: Int
    let providerMessageId: String?
    let errorCode: String?
    let sentAt: String?
}

struct DeviceRecord: Decodable, Identifiable {
    let id: String
    let name: String
    let platform: String
    let apnsEnvironment: String
    let appVersion: String?
    let buildNumber: String?
    let notificationAuthorization: String?
    let lastActiveAt: String
    let pushEnabled: Bool
}

struct DevicesResponse: Decodable {
    let devices: [DeviceRecord]
}

struct AgentConnectionRecord: Decodable, Identifiable {
    let id: String
    let name: String
    let scopes: [String]
    let createdAt: String
    let lastUsedAt: String?
    let expiresAt: String?

    var createdDate: Date? { ISO8601DateFormatter.bellwireDate(from: createdAt) }
    var lastUsedDate: Date? {
        lastUsedAt.flatMap { ISO8601DateFormatter.bellwireDate(from: $0) }
    }
}

struct AgentConnectionsResponse: Decodable {
    let connections: [AgentConnectionRecord]
}

struct DirectConnectionEnvelopeRecord: Decodable, Identifiable {
    let id: String
    let deviceKeyId: String
    let projectId: String
    let manifestVersion: Int
    let algorithm: String
    let ephemeralPublicKey: String
    let sealedBox: String
    let createdAt: String
    let expiresAt: String
}

struct DirectConnectionEnvelopesResponse: Decodable {
    let envelopes: [DirectConnectionEnvelopeRecord]
}

struct DirectConnectionAckPayload: Encodable {
    let deviceKeyId: String
}

struct DirectConnectionManifest: Codable, Identifiable {
    let version: Int
    let connectionId: String
    let baseUrl: String
    let project: DirectProjectManifest
    let endpoints: DirectEndpointsManifest
    let capabilities: [String]

    var id: String { connectionId }

    var surfacesURL: URL? {
        guard version == 2,
              let base = URL(string: baseUrl),
              base.scheme?.lowercased() == "https",
              base.user == nil,
              base.password == nil,
              endpoints.surfaces.hasPrefix("/"),
              !endpoints.surfaces.hasPrefix("//")
        else { return nil }
        return URL(string: endpoints.surfaces, relativeTo: base)?.absoluteURL
    }

    func notificationURL(reference: String) -> URL? {
        guard version == 2,
              let base = URL(string: baseUrl),
              base.scheme?.lowercased() == "https",
              base.user == nil,
              base.password == nil,
              endpoints.notification.hasPrefix("/"),
              !endpoints.notification.hasPrefix("//"),
              let rawURL = URL(string: endpoints.notification, relativeTo: base)?.absoluteURL,
              var components = URLComponents(url: rawURL, resolvingAgainstBaseURL: false)
        else { return nil }
        var queryItems = components.queryItems ?? []
        queryItems.removeAll { $0.name == "ref" }
        queryItems.append(URLQueryItem(name: "ref", value: reference))
        components.queryItems = queryItems
        return components.url
    }

    func inboxURL(cursor: String? = nil, limit: Int = 50) -> URL? {
        guard version == 2,
              let base = URL(string: baseUrl),
              base.scheme?.lowercased() == "https",
              base.user == nil,
              base.password == nil,
              endpoints.inbox.hasPrefix("/"),
              !endpoints.inbox.hasPrefix("//"),
              let rawURL = URL(string: endpoints.inbox, relativeTo: base)?.absoluteURL,
              var components = URLComponents(url: rawURL, resolvingAgainstBaseURL: false)
        else { return nil }
        var queryItems = components.queryItems ?? []
        queryItems.removeAll { $0.name == "cursor" || $0.name == "limit" }
        if let cursor {
            queryItems.append(URLQueryItem(name: "cursor", value: cursor))
        }
        queryItems.append(URLQueryItem(name: "limit", value: String(min(max(limit, 1), 50))))
        components.queryItems = queryItems
        return components.url
    }
}

struct DirectEndpointsManifest: Codable {
    let notification: String
    let inbox: String
    let surfaces: String
}

struct DirectProjectManifest: Codable {
    let id: String
    let name: String
    let icon: String
    let logoUrl: String?
    let displayOrder: Int
    let category: String
}

struct PrivateInboxPage: Decodable {
    let events: [PrivateEventPayload]
    let nextCursor: String?
}

struct PrivateEventPayload: Codable {
    let reference: String
    let eventType: String
    let title: String
    let body: String
    let subtitle: String?
    let occurredAt: String
    let data: [String: JSONValue]
    let deepLink: String?
    let logoUrl: String?
}

struct AccountEntitlement: Codable {
    let plan: String
    let status: String
    let deployment: String?
    let capabilities: EntitlementCapabilities?
    let productId: String?
    let expiresAt: String?
    let downgradeDeadline: String?
    let limits: PlanLimits
    let usage: SignalUsage
    let activeProjects: Int
    let activeDevices: Int

    var isSelfHosted: Bool { deployment == "self_hosted" }

    var hasPro: Bool {
        isSelfHosted || (plan == "pro" && (status == "active" || status == "grace"))
    }

    var canExportProjects: Bool { capabilities?.projectExport ?? hasPro }
    var canUseLiveActivities: Bool { capabilities?.liveActivities ?? hasPro }
    var billingEnabled: Bool { capabilities?.billing != "disabled" && !isSelfHosted }
    var planDisplayName: String { isSelfHosted ? "Self-hosted" : (hasPro ? "Pro" : "Free") }
}

struct EntitlementCapabilities: Codable {
    let billing: String
    let commercialLimitsEnforced: Bool
    let projectExport: Bool
    let liveActivities: Bool
}

struct PlanLimits: Codable {
    let activeProjects: Int
    let activeDevices: Int
    let monthlySignals: Int
    let courtesySignals: Int
    let ingestPerMinute: Int
    let hostedRetentionDays: Int
    let surfacesPerProject: Int?
}

struct SignalUsage: Codable {
    let periodStart: String
    let periodEnd: String
    let acceptedSignals: Int
    let remainingSignals: Int
    let courtesyRemainingSignals: Int
}

struct AppleTransactionPayload: Encodable {
    let signedTransactionInfo: String
    let source: String
}

struct ProductAnalyticsPayload: Encodable {
    let event: String
    let properties: [String: String]
}

struct DeliveryModeChangeRequest: Decodable, Identifiable {
    let id: String
    let projectId: String
    let fromMode: ProjectDeliveryMode
    let toMode: ProjectDeliveryMode
    let status: String
    let createdAt: String
    let expiresAt: String
}

struct DeliveryModeChangeRequestsResponse: Decodable {
    let requests: [DeliveryModeChangeRequest]
}

struct BindingResponse: Decodable, Identifiable {
    let code: String
    let expiresAt: String
    var id: String { code }
}

struct ReadResponse: Decodable {
    let readAt: String
}

struct ReadAllResponse: Decodable {
    let readAt: String
    let updatedCount: Int
}

struct UpdateProjectPayload: Encodable {
    let status: String
}

enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try container.decode([JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var displayValue: String {
        switch self {
        case .string(let value): return value
        case .number(let value):
            return value.formatted(.number.precision(.fractionLength(0...2)))
        case .bool(let value): return value ? "Yes" : "No"
        case .object: return "Object"
        case .array(let value): return "\(value.count) items"
        case .null: return "—"
        }
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }
}

struct APIErrorEnvelope: Decodable {
    let error: APIErrorBody
}

struct APIErrorBody: Decodable {
    let code: String
    let message: String
}

extension ISO8601DateFormatter {
    static let bellwire: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let bellwireWithoutFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func bellwireDate(from value: String) -> Date? {
        bellwire.date(from: value) ?? bellwireWithoutFractionalSeconds.date(from: value)
    }
}

extension String {
    var humanizedEventType: String {
        split(whereSeparator: { $0 == "." || $0 == "_" || $0 == "-" })
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}
