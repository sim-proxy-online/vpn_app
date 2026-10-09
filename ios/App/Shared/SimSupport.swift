import Foundation
import Network

// Общие помощники для приложения и расширения PacketTunnel.
// Файл добавлен в оба таргета (см. project.pbxproj: SimSupport.swift
// встречается в Sources-фазах и App, и PacketTunnel).

// MARK: - Очистка сообщений об ошибках

/// Требование продукта: в сообщениях для пользователя не должно быть сырых адресов
/// вида `x.petrovich.party/193.187.93.181:443`. Прячем IPv4/IPv6/хосты:порты/URL,
/// оставляя человекочитаемую суть (таймаут, отказ в соединении и т.п.).
enum SimErrorSanitizer {
    private static let patterns: [NSRegularExpression] = {
        [
            // URL с схемой: https://host[:port][/path]
            try! NSRegularExpression(pattern: "(?i)\\b[a-z][a-z0-9+.-]*://[^\\s\"'<>]+"),
            // Хост:порт
            try! NSRegularExpression(pattern: "\\b(?:[a-z0-9-]+\\.)+[a-z]{2,}(?::\\d{2,5})?\\b"),
            // IPv4[:port]
            try! NSRegularExpression(pattern: "\\b\\d{1,3}(?:\\.\\d{1,3}){3}(?::\\d{1,5})?\\b"),
            // IPv6 (грубый, но достаточный для вычистки)
            try! NSRegularExpression(pattern: "\\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\\b", options: .caseInsensitive)
        ]
    }()

    static func sanitize(_ raw: String) -> String {
        var result = raw
        for regex in patterns {
            result = regex.stringByReplacingMatches(
                in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "[адрес скрыт]")
        }
        return result
    }

    /// Короткая кодировка причины TCP-сбоя для TcpProbeResult.stage/error.
    static func tcpStage(_ error: NWError) -> String {
        switch error {
        case .dns(let code):
            return code == EAI_NONAME ? "nxdomain" : "dns"
        case .posix(let code):
            switch code {
            case .ECONNREFUSED: return "refused"
            case .ECONNRESET: return "reset"
            case .ETIMEDOUT: return "timeout"
            case .ENETUNREACH, .EHOSTUNREACH: return "unreachable"
            default: return "posix-\(code.rawValue)"
            }
        case .tls:
            return "tls"
        @unknown default:
            return "unknown"
        }
    }
}

// MARK: - HTTP-помощники

/// Зеркалит семантику Java NativeBridge.fetchUrl: ≤5 редиректов, UA по умолчанию
/// SimProxy/<версия>, таймаут 20 с, разбор заголовков подписки (profile-title,
/// subscription-userinfo, hiddify-app-info, content-disposition, profile-update-url).
enum SimHttp {
    /// Наш User-Agent по умолчанию: SimProxy/<версия приложения>.
    static var defaultUserAgent: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        return "SimProxy/\(v)"
    }

    struct FetchOutcome {
        var ok: Bool
        var body: String
        var name: String?
        var userInfo: String?
        var updateInterval: Int?
        var webPage: String?
        var supportUrl: String?
        var newUrl: String?
        var headers: [String: String] = [:]
        var error: String?

        var asDict: [String: Any] {
            var d: [String: Any] = ["ok": ok, "body": body]
            if let name = name { d["name"] = name }
            if let userInfo = userInfo { d["userInfo"] = userInfo }
            if let updateInterval = updateInterval { d["updateInterval"] = updateInterval }
            if let webPage = webPage { d["webPage"] = webPage }
            if let supportUrl = supportUrl { d["supportUrl"] = supportUrl }
            if let newUrl = newUrl { d["newUrl"] = newUrl }
            if !headers.isEmpty { d["headers"] = headers }
            if let error = error { d["error"] = error }
            return d
        }
    }

    private static let interestingHeaders = [
        "profile-title", "subscription-userinfo", "hiddify-app-info",
        "content-disposition", "profile-update-url", "profile-web-page-url",
        "support-url", "subscription-userinfo", "profile-title-base64"
    ]

    static func fetch(urlString: String, userAgent: String, timeout: TimeInterval, completion: @escaping (FetchOutcome) -> Void) {
        guard let url = URL(string: urlString), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            completion(FetchOutcome(ok: false, body: "", error: "bad-url"))
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        config.httpMaximumConnectionsPerHost = 2
        let session = URLSession(configuration: config)

        let task = session.dataTask(with: request) { data, response, error in
            if let error = error {
                completion(FetchOutcome(ok: false, body: "", error: SimErrorSanitizer.sanitize(error.localizedDescription)))
                return
            }
            guard let http = response as? HTTPURLResponse else {
                completion(FetchOutcome(ok: false, body: "", error: "no-response"))
                return
            }
            let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            guard (200..<300).contains(http.statusCode) else {
                completion(FetchOutcome(ok: false, body: body, error: "http-\(http.statusCode)"))
                return
            }
            var outcome = FetchOutcome(ok: true, body: body)
            var headers: [String: String] = [:]
            for key in http.allHeaderFields.keys {
                if let name = key as? String {
                    if let value = http.value(forHTTPHeaderField: name) {
                        headers[name.lowercased()] = value
                    }
                }
            }
            for interesting in interestingHeaders {
                if let value = headers[interesting] { outcome.headers[interesting] = value }
            }
            if let title = headers["profile-title"] { outcome.name = SimHttp.decodeHeaderTitle(title) }
            if let info = headers["subscription-userinfo"] { outcome.userInfo = info }
            if let hiddify = headers["hiddify-app-info"] { outcome.userInfo = outcome.userInfo ?? hiddify }
            if let interval = headers["profile-update-interval"], let n = Int(interval.trimmingCharacters(in: .whitespaces)) {
                outcome.updateInterval = n
            }
            if let page = headers["profile-web-page-url"] { outcome.webPage = page }
            if let support = headers["support-url"] { outcome.supportUrl = support }
            if let disposition = headers["content-disposition"] {
                if let extracted = SimHttp.filenameFromContentDisposition(disposition) {
                    outcome.name = outcome.name ?? extracted
                }
            }
            completion(outcome)
        }
        task.resume()
    }

    /// profile-title иногда отдаётся base64 (эмодзи-названия подписок).
    private static func decodeHeaderTitle(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("base64,") || trimmed.hasPrefix("base64:") {
            let payload = trimmed.dropFirst("base64,".count)
            if let data = Data(base64Encoded: String(payload)), let s = String(data: data, encoding: .utf8) {
                return s
            }
        }
        return trimmed
    }

    private static func filenameFromContentDisposition(_ header: String) -> String? {
        guard let range = header.range(of: "filename*=utf-8''") else {
            guard let simple = header.range(of: "filename=\"") else { return nil }
            let rest = header[simple.upperBound...]
            if let end = rest.firstIndex(of: "\"") { return String(rest[..<end]) }
            return nil
        }
        let rest = header[range.upperBound...]
        return String(rest).trimmingCharacters(in: .whitespaces)
    }

    /// Временной HEAD: возвращает миллисекунды или -1.
    static func timedHead(urlString: String, timeout: TimeInterval, completion: @escaping (Double) -> Void) {
        guard let url = URL(string: urlString) else { completion(-1); return }
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        request.timeoutInterval = timeout
        request.setValue(SimHttp.defaultUserAgent, forHTTPHeaderField: "User-Agent")

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.waitsForConnectivity = false
        let session = URLSession(configuration: config)

        let started = DispatchTime.now()
        let task = session.dataTask(with: request) { _, response, _ in
            let ms = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000.0
            if let http = response as? HTTPURLResponse, (200..<400).contains(http.statusCode) {
                completion(ms)
            } else {
                completion(-1)
            }
        }
        task.resume()
    }

    /// Скачивание для speed test: возвращает (мс, байты) или (-1, 0).
    static func timedDownload(urlString: String, timeout: TimeInterval, completion: @escaping (Double, Int64) -> Void) {
        guard let url = URL(string: urlString) else { completion(-1, 0); return }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.setValue(SimHttp.defaultUserAgent, forHTTPHeaderField: "User-Agent")

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForResource = timeout
        config.waitsForConnectivity = false
        let session = URLSession(configuration: config)

        let started = DispatchTime.now()
        let task = session.dataTask(with: request) { data, response, _ in
            let ms = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000.0
            let bytes = Int64(data?.count ?? 0)
            if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), bytes > 0 {
                completion(ms, bytes)
            } else {
                completion(-1, 0)
            }
        }
        task.resume()
    }
}

// MARK: - Разбор cdn-cgi/trace

enum SimTrace {
    static func parse(_ body: String, key: String) -> String? {
        for line in body.components(separatedBy: .newlines) {
            if line.hasPrefix("\(key)=") {
                return String(line.dropFirst(key.count + 1)).trimmingCharacters(in: .whitespaces)
            }
        }
        return nil
    }
}

// MARK: - Разбор Xray-конфига

/// Достаёт адрес/порт первого outbound из конфига, чтобы померить доступность сервера.
enum SimXrayConfig {
    static func extractOutboundEndpoint(_ configJson: String) -> (host: String, port: Int)? {
        guard let data = configJson.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let outbounds = root["outbounds"] as? [[String: Any]] else { return nil }

        for outbound in outbounds {
            let tag = outbound["tag"] as? String ?? ""
            // Пропускаем служебные outbounds: dns/direct/block.
            if tag == "dns-out" || tag == "direct" || tag == "block" { continue }
            guard let protocolName = outbound["protocol"] as? String else { continue }
            if protocolName == "dns" || protocolName == "freedom" || protocolName == "blackhole" { continue }

            let settings = outbound["settings"] as? [String: Any]
            let vnext = settings?["vnext"] as? [[String: Any]]
            let servers = settings?["servers"] as? [[String: Any]]

            if let first = vnext?.first {
                let host = first["address"] as? String ?? ""
                let port = first["port"] as? Int ?? 0
                if !host.isEmpty && port > 0 { return (host, port) }
            }
            if let first = servers?.first {
                let host = first["address"] as? String ?? ""
                let port = first["port"] as? Int ?? 0
                if !host.isEmpty && port > 0 { return (host, port) }
            }
        }
        return nil
    }
}
