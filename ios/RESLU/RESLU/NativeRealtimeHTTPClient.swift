import Foundation
import WebKit

enum NativeRealtimeHTTPError: LocalizedError {
    case unavailable
    case invalidResponse
    case rejected(Int, String)

    var errorDescription: String? {
        switch self {
        case .unavailable: return "The authenticated RESLU service is unavailable."
        case .invalidResponse: return "RESLU returned an invalid response."
        case let .rejected(status, message):
            return message.isEmpty ? "RESLU rejected the request (\(status))." : message
        }
    }
}

@MainActor
final class NativeRealtimeHTTPClient {
    private let origin = URL(string: "https://spec.reslu.com.au")!
    private let pendingCallEndsKey = "au.com.reslu.spec.native-call-ends.v1"
    private let maximumPendingCallEnds = 20
    private weak var cookieStore: WKHTTPCookieStore?

    func attach(cookieStore: WKHTTPCookieStore) {
        self.cookieStore = cookieStore
        Task { await flushPendingCallEnds() }
    }

    private func cookies() async -> [HTTPCookie] {
        guard let cookieStore else { return [] }
        return await withCheckedContinuation { continuation in
            cookieStore.getAllCookies { continuation.resume(returning: $0) }
        }
    }

    private func request(
        path: String,
        method: String,
        body: Data? = nil,
        contentType: String? = nil,
        headers: [String: String] = [:]
    ) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: path, relativeTo: origin), url.host == origin.host else {
            throw NativeRealtimeHTTPError.unavailable
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 20
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        let eligible = await cookies().filter { cookie in
            let domain = cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))
            return origin.host == domain || origin.host?.hasSuffix(".\(domain)") == true
        }
        if let cookie = HTTPCookie.requestHeaderFields(with: eligible)["Cookie"] {
            request.setValue(cookie, forHTTPHeaderField: "Cookie")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.url?.host == origin.host else {
            throw NativeRealtimeHTTPError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw NativeRealtimeHTTPError.rejected(http.statusCode, message ?? "")
        }
        return (data, http)
    }

    func createRealtimeSession(conversationId: String, agentSlug: String, offer: String) async throws -> String {
        let (data, _) = try await request(
            path: "/api/conversations/\(conversationId)/realtime/session",
            method: "POST",
            body: Data(offer.utf8),
            contentType: "application/sdp",
            headers: ["X-RESLU-Agent": agentSlug]
        )
        guard let answer = String(data: data, encoding: .utf8), answer.hasPrefix("v=0") else {
            throw NativeRealtimeHTTPError.invalidResponse
        }
        return answer
    }

    func json(
        path: String,
        method: String = "GET",
        body: [String: Any]? = nil
    ) async throws -> [String: Any] {
        let encoded = try body.map { try JSONSerialization.data(withJSONObject: $0) }
        let (data, _) = try await request(
            path: path,
            method: method,
            body: encoded,
            contentType: encoded == nil ? nil : "application/json"
        )
        guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NativeRealtimeHTTPError.invalidResponse
        }
        return result
    }

    private func pendingCallEnd(
        conversationId: String,
        callId: String,
        nativeContinuity: [String: Any]
    ) -> [String: Any] {
        [
            "conversation_id": conversationId,
            "call_id": callId,
            "native_continuity": nativeContinuity,
        ]
    }

    private func storedPendingCallEnds() -> [[String: Any]] {
        UserDefaults.standard.array(forKey: pendingCallEndsKey) as? [[String: Any]] ?? []
    }

    private func storePendingCallEnds(_ entries: [[String: Any]]) {
        UserDefaults.standard.set(Array(entries.suffix(maximumPendingCallEnds)), forKey: pendingCallEndsKey)
    }

    private func queuePendingCallEnd(_ entry: [String: Any]) {
        guard let callId = entry["call_id"] as? String else { return }
        let retained = storedPendingCallEnds().filter { $0["call_id"] as? String != callId }
        storePendingCallEnds(retained + [entry])
    }

    private func submitCallEnd(_ entry: [String: Any]) async -> Bool {
        guard
            let conversationId = entry["conversation_id"] as? String,
            let callId = entry["call_id"] as? String,
            let nativeContinuity = entry["native_continuity"] as? [String: Any]
        else { return true }
        do {
            _ = try await json(
                path: "/api/conversations/\(conversationId)/calls",
                method: "PATCH",
                body: ["call_id": callId, "native_continuity": nativeContinuity]
            )
            return true
        } catch {
            return false
        }
    }

    func endCall(conversationId: String, callId: String, nativeContinuity: [String: Any]) {
        let entry = pendingCallEnd(
            conversationId: conversationId,
            callId: callId,
            nativeContinuity: nativeContinuity
        )
        // Persist before the first suspension point. A CallKit end action may
        // be followed by immediate background suspension, so waiting for the
        // network before creating the retry entry can lose the canonical end.
        queuePendingCallEnd(entry)
        Task { [weak self] in
            guard let self else { return }
            if await submitCallEnd(entry) {
                storePendingCallEnds(storedPendingCallEnds().filter { $0["call_id"] as? String != callId })
            }
        }
    }

    func flushPendingCallEnds() async {
        let pending = storedPendingCallEnds()
        guard !pending.isEmpty else { return }
        var retained = [[String: Any]]()
        for entry in pending {
            if !(await submitCallEnd(entry)) { retained.append(entry) }
        }
        let snapshotIds = Set(pending.compactMap { $0["call_id"] as? String })
        let queuedWhileFlushing = storedPendingCallEnds().filter {
            guard let callId = $0["call_id"] as? String else { return false }
            return !snapshotIds.contains(callId)
        }
        storePendingCallEnds(retained + queuedWhileFlushing)
    }
}
