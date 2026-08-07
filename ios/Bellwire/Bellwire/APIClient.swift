// SPDX-License-Identifier: MPL-2.0
import Foundation

enum HTTPMethod: String {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
    case patch = "PATCH"
    case delete = "DELETE"
}

struct APIClient {
    var accessTokenProvider: () async throws -> String

    private let session: URLSession
    private let decoder: JSONDecoder
    private let apiEncoder: JSONEncoder
    private let supabaseEncoder: JSONEncoder

    init(
        session: URLSession = .shared,
        accessTokenProvider: @escaping () async throws -> String
    ) {
        self.session = session
        self.accessTokenProvider = accessTokenProvider
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        self.decoder = decoder
        self.apiEncoder = JSONEncoder()
        let supabaseEncoder = JSONEncoder()
        supabaseEncoder.keyEncodingStrategy = .convertToSnakeCase
        self.supabaseEncoder = supabaseEncoder
    }

    func request<Response: Decodable>(
        _ path: String,
        method: HTTPMethod = .get,
        body: (any Encodable)? = nil
    ) async throws -> Response {
        let data = try await performAPIRequest(path, method: method, body: body)
        return try decoder.decode(Response.self, from: data)
    }

    func requestVoid(
        _ path: String,
        method: HTTPMethod,
        body: (any Encodable)? = nil
    ) async throws {
        _ = try await performAPIRequest(path, method: method, body: body)
    }

    func requestData(
        _ path: String,
        method: HTTPMethod = .get,
        body: (any Encodable)? = nil
    ) async throws -> Data {
        try await performAPIRequest(path, method: method, body: body)
    }

    private func performAPIRequest(
        _ path: String,
        method: HTTPMethod,
        body: (any Encodable)?
    ) async throws -> Data {
        let token = try await accessTokenProvider()
        let baseURL = AppConfig.apiBaseURL.appendingPathComponent("")
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw ClientError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try apiEncoder.encode(AnyEncodable(body))
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            if let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data) {
                throw ClientError.api(code: envelope.error.code, message: envelope.error.message)
            }
            throw ClientError.httpStatus(http.statusCode)
        }
        return data
    }

    func exchangeAppleIdentityToken(_ identityToken: String, nonce: String) async throws -> AuthSession {
        struct Payload: Encodable {
            let provider = "apple"
            let idToken: String
            let nonce: String
        }
        var components = URLComponents(
            url: AppConfig.supabaseURL.appending(path: "auth/v1/token"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "grant_type", value: "id_token")]
        var request = URLRequest(url: components.url!)
        request.httpMethod = HTTPMethod.post.rawValue
        request.setValue(AppConfig.supabasePublishableKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try supabaseEncoder.encode(Payload(idToken: identityToken, nonce: nonce))
        return try await performSupabaseTokenRequest(request)
    }

    func saveAppleAuthorizationCode(_ authorizationCode: String) async throws {
        struct Payload: Encodable { let authorizationCode: String }
        try await requestVoid(
            "v1/auth/apple/authorization",
            method: .post,
            body: Payload(authorizationCode: authorizationCode)
        )
    }

    func refreshSession(_ refreshToken: String) async throws -> AuthSession {
        struct Payload: Encodable { let refreshToken: String }
        var components = URLComponents(
            url: AppConfig.supabaseURL.appending(path: "auth/v1/token"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "grant_type", value: "refresh_token")]
        var request = URLRequest(url: components.url!)
        request.httpMethod = HTTPMethod.post.rawValue
        request.setValue(AppConfig.supabasePublishableKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try supabaseEncoder.encode(Payload(refreshToken: refreshToken))
        return try await performSupabaseTokenRequest(request)
    }

    private func performSupabaseTokenRequest(_ request: URLRequest) async throws -> AuthSession {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["msg"] as? String
            throw ClientError.api(code: "AUTH_FAILED", message: message ?? "Sign in failed. Please try again.")
        }
        return try decoder.decode(SupabaseTokenResponse.self, from: data).session()
    }
}

private struct AnyEncodable: Encodable {
    private let encodeValue: (Encoder) throws -> Void
    init(_ value: any Encodable) { encodeValue = value.encode }
    func encode(to encoder: Encoder) throws { try encodeValue(encoder) }
}

enum ClientError: LocalizedError {
    case invalidResponse
    case httpStatus(Int)
    case api(code: String, message: String)
    case signedOut

    var errorDescription: String? {
        switch self {
        case .invalidResponse: return "The server returned an invalid response."
        case .httpStatus(let status): return "The server returned status \(status)."
        case .api(_, let message): return message
        case .signedOut: return "Please sign in again."
        }
    }
}
