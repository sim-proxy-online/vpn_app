import Foundation
import Network
import NetworkExtension
import SwiftyXrayKit

/// Packet Tunnel Provider: поднимает Xray поверх системного TUN и мостит пакеты
/// в ядро через socketpair (см. SwiftyXrayKit/XrayBridge).
///
/// Схема обмена с приложением — без App Groups: providerConfiguration несёт
/// стартовый конфиг, а статистика ходит через handleAppMessage / sendMessage.
///
/// Память: расширения Network Extension живут под ~50 МБ лимита (libXray issue #102),
/// поэтому пресет ограничен memoryLimitMB = 30.
class PacketTunnelProvider: NEPacketTunnelProvider {

    private var xrayBridge: XrayBridge?
    private var statsTimer: DispatchSourceTimer?

    // Копим байты между опросами, чтобы отдать скорость и нарастающий итог.
    private var totalReceived: Int64 = 0
    private var totalSent: Int64 = 0
    private var lastUplinkSpeed: Int64 = 0
    private var lastDownlinkSpeed: Int64 = 0
    private var startedAt: Date?
    private var logRing: [String] = []

    private let statsQueue = DispatchQueue(label: "sim.proxy.ios.stats")

    private func log(_ line: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        statsQueue.sync {
            logRing.append("[\(stamp)] \(line)")
            if logRing.count > 300 { logRing.removeFirst(logRing.count - 300) }
        }
        NSLog("[SimProxy-Tunnel] %@", line)
    }

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        guard let proto = protocolConfiguration as? NETunnelProviderProtocol,
              let providerConfig = proto.providerConfiguration else {
            completionHandler(NSError(domain: "sim.proxy.ios", code: 1,
                                      userInfo: [NSLocalizedDescriptionKey: "Нет конфигурации туннеля"]))
            return
        }

        let configJson = providerConfig["config"] as? String ?? ""
        let settingsJson = providerConfig["settings"] as? String ?? "{}"
        let shield = (providerConfig["shield"] as? String) == "1"
        let socksPort = Int(providerConfig["socksPort"] as? String ?? "10808") ?? 10808

        guard !configJson.isEmpty else {
            completionHandler(NSError(domain: "sim.proxy.ios", code: 2,
                                      userInfo: [NSLocalizedDescriptionKey: "Пустой конфиг ядра"]))
            return
        }

        log("startTunnel shield=\(shield) socks=\(socksPort)")

        // Режим «Иммунитет»: туннель поднят, но весь трафик идёт direct.
        // Подменяем первый outbound на freedom, сохраняя тег, чтобы правила маршрутизации сходились.
        let effectiveConfig: String
        if shield {
            effectiveConfig = PacketTunnelProvider.applyShield(configJson: configJson)
        } else {
            effectiveConfig = configJson
        }

        // DNS: берём из настроек, иначе 1.1.1.1.
        let dnsServers = PacketTunnelProvider.dnsFromSettings(settingsJson: settingsJson)

        // 1) Сеть туннеля — до старта ядра, чтобы системный стек уже знал маршрут.
        let networkSettings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: "198.18.0.1")
        let ipv4 = NEIPv4Settings(addresses: ["172.19.0.1"], subnetMasks: ["255.255.255.252"])
        ipv4.includedRoutes = [NEIPv4Route.default()]
        networkSettings.ipv4Settings = ipv4

        let ipv6 = NEIPv6Settings(addresses: ["fd00:10::1"], networkPrefixLengths: [128])
        ipv6.includedRoutes = [NEIPv6Route.default()]
        networkSettings.ipv6Settings = ipv6

        let dns = NEDNSSettings(servers: dnsServers)
        dns.matchDomains = [""]
        networkSettings.dnsSettings = dns
        networkSettings.mtu = 1360

        setTunnelNetworkSettings(networkSettings) { [weak self] error in
            guard let self = self else { return }
            if let error = error {
                self.log("setTunnelNetworkSettings failed: \(SimErrorSanitizer.sanitize(error.localizedDescription))")
                completionHandler(error)
                return
            }

            // 2) Ядро.
            do {
                let bridge = XrayBridge(packetFlow: self.packetFlow)
                let dataDir = PacketTunnelProvider.geoDataDir()
                let configPath = FileManager.default.temporaryDirectory
                    .appendingPathComponent("xray-ios-final.json")

                // У SwiftyXrayKit 2.0.0 все пять параметров обязательны (дефолтов нет).
                let sniffing = SniffingConfiguration(
                    destOverride: ["http", "tls", "quic"],
                    enabled: true,
                    routeOnly: true,
                    domainsExcluded: [],
                    metadataOnly: false
                )

                // SwiftyXrayKit подменяет inbounds на один TUN-инбаунд — SOCKS inbound
                // из JS-конфига нужно вернуть, иначе проба через живой SOCKS не работает.
                let socks = socksPort
                let transform: ([String: Any]) -> [String: Any] = { dict in
                    var out = dict
                    var inbounds = out["inbounds"] as? [[String: Any]] ?? []
                    inbounds.append([
                        "tag": "socks-in",
                        "port": socks,
                        "listen": "127.0.0.1",
                        "protocol": "socks",
                        "settings": [
                            "udp": true,
                            "auth": "noauth",
                            "userLevel": 8
                        ],
                        "sniffing": [
                            "enabled": true,
                            "destOverride": ["http", "tls", "quic"],
                            "routeOnly": false
                        ]
                    ])
                    out["inbounds"] = inbounds
                    return out
                }

                let preset = XrayTuningPreset(
                    memoryLimitMB: 30,
                    tcpBufMaxKB: 512,
                    tcpMaxInFlight: 256,
                    udpMaxConns: 256,
                    idleTimeoutSec: 300
                )

                try bridge.start(
                    config: .json(effectiveConfig),
                    dataDir: dataDir,
                    finalConfigPath: configPath,
                    sniffing: sniffing,
                    preset: preset,
                    configTransform: transform,
                    traceHandle: { [weak self] message in self?.log("xray: \(message)") }
                )

                self.xrayBridge = bridge
                self.startedAt = Date()
                self.log("xray started, dataDir=\(dataDir.path)")
                self.startStatsTimer()
                completionHandler(nil)
            } catch {
                let msg = SimErrorSanitizer.sanitize(String(describing: error))
                self.log("xray start failed: \(msg)")
                completionHandler(NSError(domain: "sim.proxy.ios", code: 3,
                                          userInfo: [NSLocalizedDescriptionKey: "Не удалось запустить ядро: \(msg)"]))
            }
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        log("stopTunnel reason=\(reason.rawValue)")
        statsTimer?.cancel()
        statsTimer = nil
        xrayBridge?.stop()
        xrayBridge = nil
        completionHandler()
    }

    override func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)?) {
        let cmd = PacketTunnelProvider.command(from: messageData)
        switch cmd {
        case "stats":
            let stats = collectStats()
            let data = try? JSONSerialization.data(withJSONObject: stats, options: [])
            completionHandler?(data)
        case "logs":
            var lines: [String] = []
            statsQueue.sync { lines = logRing }
            completionHandler?(Data(lines.joined(separator: "\n").utf8))
        default:
            completionHandler?(nil)
        }
    }

    // MARK: - Статистика

    private func startStatsTimer() {
        let timer = DispatchSource.makeTimerSource(queue: statsQueue)
        timer.schedule(deadline: .now() + .seconds(2), repeating: .seconds(2))
        timer.setEventHandler { [weak self] in
            self?.drainStats()
        }
        timer.resume()
        statsTimer = timer
    }

    private func drainStats() {
        guard let bridge = xrayBridge else { return }
        let delta = bridge.getAndClearStats()
        let elapsed: Double
        if let startedAt = startedAt {
            elapsed = max(1.0, Date().timeIntervalSince(startedAt))
        } else {
            elapsed = 1.0
        }
        // Скорость — за последний интервал опроса (2 с), в байтах/с.
        lastDownlinkSpeed = Int64(Double(delta.received) / 2.0)
        lastUplinkSpeed = Int64(Double(delta.sent) / 2.0)
        totalReceived += delta.received
        totalSent += delta.sent
        _ = elapsed
    }

    private func collectStats() -> [String: Any] {
        // Досчитываем хвост, если таймер не успел.
        if let bridge = xrayBridge {
            let delta = bridge.getAndClearStats()
            totalReceived += delta.received
            totalSent += delta.sent
            lastDownlinkSpeed = Int64(Double(delta.received) / 2.0)
            lastUplinkSpeed = Int64(Double(delta.sent) / 2.0)
        }
        let connectedSec = startedAt.map { Int(Date().timeIntervalSince($0)) } ?? 0
        return [
            "status": "connected",
            "upload": totalSent,
            "download": totalReceived,
            "uplinkSpeed": lastUplinkSpeed,
            "downlinkSpeed": lastDownlinkSpeed,
            "connectedSec": connectedSec
        ]
    }

    // MARK: - Вспомогательное

    private static func command(from data: Data) -> String {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return "" }
        return obj["cmd"] as? String ?? ""
    }

    /// Режим «Иммунитет»: первый (основной) outbound заменяем на freedom с тем же тегом.
    private static func applyShield(configJson: String) -> String {
        guard let data = configJson.data(using: .utf8),
              var root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              var outbounds = root["outbounds"] as? [[String: Any]] else { return configJson }
        for index in outbounds.indices {
            let tag = outbounds[index]["tag"] as? String ?? ""
            if tag == "dns-out" || tag == "direct" || tag == "block" { continue }
            outbounds[index] = ["tag": tag.isEmpty ? "proxy" : tag, "protocol": "freedom"]
            break
        }
        root["outbounds"] = outbounds
        guard let rewritten = try? JSONSerialization.data(withJSONObject: root, options: []),
              let json = String(data: rewritten, encoding: .utf8) else { return configJson }
        return json
    }

    private static func dnsFromSettings(settingsJson: String) -> [String] {
        guard let data = settingsJson.data(using: .utf8),
              let settings = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return ["1.1.1.1"]
        }
        var servers: [String] = []
        if let custom = (settings["dnsAddress"] as? String)?.trimmingCharacters(in: .whitespaces),
           !custom.isEmpty, isValidDnsServer(custom) {
            servers.append(custom)
        }
        // DoH как запасной: на ТСПУ-сетях UDP/53 к зарубежным IP блокируется.
        servers.append("https://cloudflare-dns.com/dns-query")
        if !servers.contains("1.1.1.1") { servers.append("1.1.1.1") }
        return servers
    }

    private static func isValidDnsServer(_ value: String) -> Bool {
        // Принимаем IPv4, IPv6 и DoH-URL.
        if value.hasPrefix("https://") || value.hasPrefix("http://") { return true }
        var addr = sockaddr_in()
        return value.withCString { inet_pton(AF_INET, $0, &addr.sin_addr) } == 1
    }

    /// geoip.dat/geosite.dat лежат в ресурсах расширения (Bundle.main здесь — это appex).
    /// Fallback — ресурсы приложения (расширение лежит в builtInPlugIns того же бандла).
    private static func geoDataDir() -> URL {
        let fm = FileManager.default
        if let resourceURL = Bundle.main.resourceURL,
           fm.fileExists(atPath: resourceURL.appendingPathComponent("geoip.dat").path) {
            return resourceURL
        }
        if let plugins = Bundle.main.builtInPlugInsURL {
            let extBundle = plugins.appendingPathComponent("PacketTunnel.appex")
            if let resources = Bundle(url: extBundle)?.resourceURL,
               fm.fileExists(atPath: resources.appendingPathComponent("geoip.dat").path) {
                return resources
            }
        }
        // Последний шанс — каталог документов (наполняется при установке).
        let docs = fm.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        return docs
    }
}
