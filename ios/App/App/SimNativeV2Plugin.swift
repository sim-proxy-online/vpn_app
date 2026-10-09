import Foundation
import UIKit
import Capacitor
import Network
import NetworkExtension
import CoreTelephony
import UserNotifications
import AudioToolbox

/// Нативный мост iOS. Регистрируется в capacitor.config.json → packageClassList
/// (см. scripts/ios-register-plugin.mjs — cap sync перезаписывает этот список,
/// поэтому класс дописывается пост-скриптом после каждой синхронизации).
///
/// JS-сторона: src/native/iosShim.ts ставит window.SimNativeV2 поверх этого плагина.
/// Каждый метод разрешается через call.resolve(["result": ...]) — шим умеет брать
/// и .result, и сам объект, поэтому форма едина для всех методов.
///
/// Осознанное отличие от Android: приложение на iOS НЕ исключено из туннеля
/// (NEPacketTunnelProvider не умеет per-app исключения), поэтому «прямые» пробы
/// из App-процеса фактически идут через туннель. Это документировано в IOS_SETUP.md.
@objc(SimNativeV2Plugin)
public class SimNativeV2Plugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SimNativeV2Plugin"
    public let jsName = "SimNativeV2"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startVpnWithResult", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopVpn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getVpnStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStats", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDetailedStats", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isShieldMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getActiveNodeId", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pingServer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pingServerDirect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "probeTcp", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "probeTcpViaTunnel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pingProxyServer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "testProxyDelay", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchUrlViaProxy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchPublicIp", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "testIpLeak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startSpeedTest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestVpnPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAllPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getBatteryStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestDozeExemption", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestOemBatterySettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkTorPort", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openOrbotInstall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPendingDeepLink", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCoreVersions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSystemInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAppVersion", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDeviceId", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLastError", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLogs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readClipboard", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentNetwork", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isNetworkAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getNetworkInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startNetworkMonitoring", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopNetworkMonitoring", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCarrier", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showNotification", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setStatusBarColor", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setStatusBarStyle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "minimizeApp", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearDnsCache", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "vibrate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pingBatch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelPingBatch", returnType: CAPPluginReturnPromise)
    ]

    // ── Состояние ────────────────────────────────────────────────────────────
    private let defaults = UserDefaults.standard
    private let stateQueue = DispatchQueue(label: "sim.proxy.ios.state")
    private var pathMonitor: NWPathMonitor?
    private var lastCarrier: String = ""
    private var pingCancelled = false
    private var logRing: [String] = []

    private enum Keys {
        static let nodeId = "sim-ios-active-node-id"
        static let shield = "sim-ios-shield"
        static let lastError = "sim-ios-last-error"
        static let startedAt = "sim-ios-started-at"
        static let providerBundle = "sim-ios-provider-bundle"
    }

    // ── Журнал (кольцевой буфер, отдаётся в DebugScreen) ─────────────────────
    private func log(_ line: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        stateQueue.sync {
            logRing.append("[\(stamp)] \(line)")
            if logRing.count > 400 { logRing.removeFirst(logRing.count - 400) }
        }
        NSLog("[SimProxy-iOS] %@", line)
    }

    private func setLastError(_ message: String) {
        defaults.set(SimErrorSanitizer.sanitize(message), forKey: Keys.lastError)
    }

    // ── VPN-менеджер ─────────────────────────────────────────────────────────
    private func loadManager(completion: @escaping (NETunnelProviderManager?) -> Void) {
        NETunnelProviderManager.loadAllFromPreferences { managers, _ in
            completion(managers?.first)
        }
    }

    private func managerStatus(_ manager: NETunnelProviderManager?) -> String {
        guard let manager = manager else { return "not_running" }
        switch manager.connection.status {
        case .connected: return "connected"
        case .connecting, .reasserting: return "starting"
        case .disconnecting: return "starting"
        case .disconnected, .invalid: return "not_running"
        @unknown default: return "not_running"
        }
    }

    /// Конфиг PacketTunnel для NE: providerConfiguration держит сырой Xray-конфиг,
    /// настройки и флаг «Иммунитета». Всё, что нужно расширению — внутри.
    private func makeProtocolConfiguration(configJson: String, settingsJson: String, shield: Bool, socksPort: Int) -> NETunnelProviderProtocol {
        let proto = NETunnelProviderProtocol()
        proto.providerBundleIdentifier = providerBundleIdentifier()
        // serverAddress обязателен для сохранения профиля; показывается в «Настройки → VPN».
        proto.serverAddress = "Петрович"
        proto.providerConfiguration = [
            "config": configJson,
            "settings": settingsJson,
            "shield": shield ? "1" : "0",
            "socksPort": String(socksPort)
        ]
        return proto
    }

    private func providerBundleIdentifier() -> String {
        // Расширение лежит внутри appex того же бандла: party.petrovich.app.PacketTunnel.
        let base = Bundle.main.bundleIdentifier ?? "party.petrovich.app"
        return base + ".PacketTunnel"
    }

    // ── Методы ───────────────────────────────────────────────────────────────

    @objc func startVpnWithResult(_ call: CAPPluginCall) {
        guard let payloadStr = call.getString("payload"),
              let payloadData = payloadStr.data(using: .utf8),
              let payload = try? JSONSerialization.jsonObject(with: payloadData) as? [String: Any] else {
            call.resolve(["result": ["ok": false, "error": "Некорректные данные подключения"]])
            return
        }
        let configJson = payload["config"] as? String ?? ""
        let settingsJson = payload["settings"] as? String ?? "{}"
        let shield = payload["shield"] as? Bool ?? false
        guard !configJson.isEmpty else {
            call.resolve(["result": ["ok": false, "error": "Пустой конфигурационный файл"]])
            return
        }

        var socksPort = 10808
        var nodeId = ""
        if let settingsData = settingsJson.data(using: .utf8),
           let settings = try? JSONSerialization.jsonObject(with: settingsData) as? [String: Any] {
            if let port = settings["socksPort"] as? String, let p = Int(port) { socksPort = p }
            if let port = settings["socksPort"] as? Int { socksPort = port }
            nodeId = settings["nodeId"] as? String ?? ""
        }

        log("startVpn shield=\(shield) nodeId=\(nodeId.isEmpty ? "?" : nodeId) socks=\(socksPort)")

        loadManager { [weak self] existing in
            guard let self = self else { return }
            let manager = existing ?? NETunnelProviderManager()
            manager.protocolConfiguration = self.makeProtocolConfiguration(
                configJson: configJson, settingsJson: settingsJson, shield: shield, socksPort: socksPort)
            manager.localizedDescription = shield ? "Петрович — Иммунитет" : "Петрович"
            manager.isEnabled = true

            manager.saveToPreferences { error in
                if let error = error {
                    let msg = SimErrorSanitizer.sanitize(error.localizedDescription)
                    self.setLastError(msg)
                    self.log("saveToPreferences failed: \(msg)")
                    // 1001 / 1102 — профиль не сохранён (чаще всего пользователь отклонил
                    // системный диалог «Добавить VPN-конфигурацию»).
                    call.resolve(["result": ["ok": false, "error": msg]])
                    return
                }
                manager.loadFromPreferences { _ in
                    do {
                        try manager.connection.startVPNTunnel(options: [:])
                        self.defaults.set(nodeId, forKey: Keys.nodeId)
                        self.defaults.set(shield, forKey: Keys.shield)
                        self.defaults.set(Date().timeIntervalSince1970, forKey: Keys.startedAt)
                        self.defaults.set("", forKey: Keys.lastError)
                        self.log("startVPNTunnel issued")
                        call.resolve(["result": ["ok": true]])
                    } catch {
                        let msg = SimErrorSanitizer.sanitize(error.localizedDescription)
                        self.setLastError(msg)
                        self.log("startVPNTunnel failed: \(msg)")
                        call.resolve(["result": ["ok": false, "error": msg]])
                    }
                }
            }
        }
    }

    @objc func stopVpn(_ call: CAPPluginCall) {
        log("stopVpn reason=\(call.getString("reason") ?? "unknown")")
        loadManager { manager in
            manager?.connection.stopVPNTunnel()
            UserDefaults.standard.removeObject(forKey: Keys.startedAt)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                call.resolve(["result": true])
            }
        }
    }

    @objc func getVpnStatus(_ call: CAPPluginCall) {
        loadManager { manager in
            let status = self.managerStatus(manager)
            let mapped = status == "connected" ? "connected" : (status == "starting" ? "connecting" : "disconnected")
            call.resolve(["result": mapped])
        }
    }

    /// Статистика туннеля. Расширение копит байты/скорость/время и отдаёт по sendMessage.
    @objc func getStats(_ call: CAPPluginCall) {
        loadManager { manager in
            let status = self.managerStatus(manager)
            guard status == "connected",
                  let session = manager?.connection as? NETunnelProviderSession else {
                call.resolve(["result": [
                    "status": status == "starting" ? "starting" : "not_running",
                    "upload": 0, "download": 0,
                    "uplinkSpeed": 0, "downlinkSpeed": 0,
                    "connectedSec": 0
                ]])
                return
            }
            let payload = "{\"cmd\":\"stats\"}".data(using: .utf8)!
            do {
                try session.sendProviderMessage(payload) { data in
                    var stats: [String: Any] = [
                        "status": "connected",
                        "upload": 0, "download": 0,
                        "uplinkSpeed": 0, "downlinkSpeed": 0,
                        "connectedSec": 0
                    ]
                    if let data = data,
                       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        for (k, v) in obj { stats[k] = v }
                    }
                    stats["status"] = "connected"
                    call.resolve(["result": stats])
                }
            } catch {
                // Расширение не приняло сообщение — отдаём нули, JS не должен висеть до таймаута.
                call.resolve(["result": [
                    "status": "connected",
                    "upload": 0, "download": 0,
                    "uplinkSpeed": 0, "downlinkSpeed": 0,
                    "connectedSec": 0
                ]])
            }
        }
    }

    @objc func getDetailedStats(_ call: CAPPluginCall) {
        // Расширенная статистика пока не отличается: достаточно базовой.
        getStats(call)
    }

    @objc func isShieldMode(_ call: CAPPluginCall) {
        call.resolve(["result": defaults.bool(forKey: Keys.shield)])
    }

    @objc func getActiveNodeId(_ call: CAPPluginCall) {
        whenStatus { status in
            guard status == "connected" || status == "starting" else {
                call.resolve(["result": ""])
                return
            }
            call.resolve(["result": self.defaults.string(forKey: Keys.nodeId) ?? ""])
        }
    }

    /// Статус VPN без БЛОКИРОВКИ потока.
    ///
    /// Capacitor вызывает методы плагина на главном потоке, а колбэк
    /// loadAllFromPreferences может прийти тоже на главном — семафор здесь дал бы
    /// дедлок. Вся логика ниже поэтому строится на вложенном асинхронном стиле.
    private func whenStatus(_ body: @escaping (String) -> Void) {
        NETunnelProviderManager.loadAllFromPreferences { [weak self] managers, _ in
            guard let self = self else { return }
            body(self.managerStatus(managers?.first))
        }
    }

    // ── Пинги и пробы ────────────────────────────────────────────────────────

    @objc func pingServer(_ call: CAPPluginCall) {
        let host = call.getString("address") ?? ""
        let port = call.getInt("port") ?? 0
        tcpProbe(host: host, port: port, timeoutMs: call.getInt("timeout") ?? 5000) { result in
            call.resolve(["result": result["ok"] as? Bool == true ? (result["ms"] as? Double ?? -1) : -1])
        }
    }

    @objc func pingServerDirect(_ call: CAPPluginCall) {
        let host = call.getString("address") ?? ""
        let port = call.getInt("port") ?? 0
        tcpProbe(host: host, port: port, timeoutMs: 5000) { result in
            call.resolve(["result": result["ok"] as? Bool == true ? (result["ms"] as? Double ?? -1) : -1])
        }
    }

    @objc func probeTcp(_ call: CAPPluginCall) {
        let host = call.getString("host") ?? ""
        let port = call.getInt("port") ?? 0
        let timeout = call.getInt("timeoutMs") ?? 5000
        tcpProbe(host: host, port: port, timeoutMs: timeout) { result in
            call.resolve(["result": result])
        }
    }

    /// iOS не умеет исключать приложение из туннеля, поэтому проба «через туннель»
    /// идёт тем же путём. Возвращаем корректный ответ, а не ошибку, чтобы
    /// диагностические экраны показывали реальные значения.
    @objc func probeTcpViaTunnel(_ call: CAPPluginCall) {
        let host = call.getString("host") ?? ""
        let port = call.getInt("port") ?? 0
        let timeout = call.getInt("timeoutMs") ?? 5000
        whenStatus { status in
            guard status == "connected" else {
                call.resolve(["result": ["ok": false, "stage": "no-vpn", "error": "vpn-off"]])
                return
            }
            self.tcpProbe(host: host, port: port, timeoutMs: timeout) { result in
                call.resolve(["result": result])
            }
        }
    }

    /// Замер RTT до сервера прокси. На iOS это TCP-тайминг до адреса из outbound:
    /// LibXray НЕ линкуется в App-таргет (бинарь ~79 МБ × 2 копии → IPA 100+ МБ),
    /// поэтому вместо полного обхода через ядро — измерение доступности хоста.
    /// Для REALITY/VLESS TCP-RTT хорошо коррелирует с реальной задержкой.
    @objc func pingProxyServer(_ call: CAPPluginCall) {
        guard let configJson = call.getString("configJson"),
              let endpoint = SimXrayConfig.extractOutboundEndpoint(configJson) else {
            call.resolve(["result": -1])
            return
        }
        tcpProbe(host: endpoint.host, port: endpoint.port, timeoutMs: 5000) { result in
            call.resolve(["result": result["ok"] as? Bool == true ? (result["ms"] as? Double ?? -1) : -1])
        }
    }

    /// RTT через туннель: временной HEAD к connectivitycheck. При выключенном
    /// туннеле возвращаем -1 (иначе watchdog фейловера начал бы честные гонки).
    @objc func testProxyDelay(_ call: CAPPluginCall) {
        whenStatus { status in
            guard status == "connected" else {
                call.resolve(["result": -1])
                return
            }
            SimHttp.timedHead(urlString: "https://connectivitycheck.gstatic.com/generate_204", timeout: 6) { ms in
                if ms > 0 {
                    call.resolve(["result": ms])
                } else {
                    SimHttp.timedHead(urlString: "https://cp.cloudflare.com/generate_204", timeout: 5) { alt in
                        call.resolve(["result": alt > 0 ? alt : -1])
                    }
                }
            }
        }
    }

    @objc func fetchUrl(_ call: CAPPluginCall) {
        let url = call.getString("url") ?? ""
        let ua = call.getString("userAgent") ?? SimHttp.defaultUserAgent
        SimHttp.fetch(urlString: url, userAgent: ua, timeout: 20) { result in
            call.resolve(["result": result.asDict])
        }
    }

    /// iOS: приложение всегда идёт через системный туннель, поэтому «через SOCKS»
    /// и обычный запрос эквивалентны. Возвращаем честный отказ, если туннеля нет.
    @objc func fetchUrlViaProxy(_ call: CAPPluginCall) {
        let url = call.getString("url") ?? ""
        let ua = call.getString("userAgent") ?? SimHttp.defaultUserAgent
        whenStatus { status in
            guard status == "connected" else {
                call.resolve(["result": ["ok": false, "error": "vpn-off", "body": ""]])
                return
            }
            SimHttp.fetch(urlString: url, userAgent: ua, timeout: 20) { result in
                call.resolve(["result": result.asDict])
            }
        }
    }

    /// Внешний IP/страна через туннель (exit). Без туннеля адрес был бы реальным —
    /// тогда отдаём null, чтобы UI не показывал «ваш адрес» вместо «нет VPN».
    @objc func fetchPublicIp(_ call: CAPPluginCall) {
        whenStatus { status in
            guard status == "connected" else {
                call.resolve(["result": NSNull()])
                return
            }
            SimHttp.fetch(urlString: "https://1.1.1.1/cdn-cgi/trace", userAgent: SimHttp.defaultUserAgent, timeout: 12) { outcome in
                guard outcome.ok,
                      let ip = SimTrace.parse(outcome.body, key: "ip"), !ip.isEmpty else {
                    call.resolve(["result": NSNull()])
                    return
                }
                var out: [String: Any] = ["ip": ip]
                if let loc = SimTrace.parse(outcome.body, key: "loc") { out["country"] = loc.lowercased() }
                call.resolve(["result": out])
            }
        }
    }

    /// Проверка утечки адреса. На iOS «настоящий» адрес через туннель неизолирован,
    /// поэтому честный ответ — это exit-адрес и признак «проверить нельзя».
    @objc func testIpLeak(_ call: CAPPluginCall) {
        let ts = Int(Date().timeIntervalSince1970 * 1000)
        whenStatus { status in
            guard status == "connected" else {
                call.resolve(["result": [
                    "ipAddress": "", "country": "",
                    "hasLeak": false, "inconclusive": true,
                    "error": "vpn-off", "timestamp": ts
                ]])
                return
            }
            SimHttp.fetch(urlString: "https://1.1.1.1/cdn-cgi/trace", userAgent: SimHttp.defaultUserAgent, timeout: 12) { outcome in
                guard outcome.ok,
                      let ip = SimTrace.parse(outcome.body, key: "ip"), !ip.isEmpty else {
                    call.resolve(["result": [
                        "ipAddress": "", "country": "",
                        "hasLeak": false, "inconclusive": true, "timestamp": ts
                    ]])
                    return
                }
                var out: [String: Any] = [
                    "ipAddress": ip, "hasLeak": false,
                    "inconclusive": true, "timestamp": ts
                ]
                if let loc = SimTrace.parse(outcome.body, key: "loc") { out["country"] = loc.lowercased() }
                call.resolve(["result": out])
            }
        }
    }

    @objc func startSpeedTest(_ call: CAPPluginCall) {
        let url = "https://speed.cloudflare.com/__down?bytes=2500000"
        SimHttp.timedDownload(urlString: url, timeout: 30) { ms, bytes in
            let kbps = ms > 0 && bytes > 0 ? Double(bytes) * 8.0 / (ms / 1000.0) / 1000.0 : 0
            call.resolve(["result": [
                "download": Int(kbps),
                "upload": 0,
                "ping": Int(ms),
                "timestamp": Int(Date().timeIntervalSince1970 * 1000)
            ]])
        }
    }

    // ── Разрешения и устройство ──────────────────────────────────────────────

    @objc func requestVpnPermission(_ call: CAPPluginCall) {
        // На iOS нет отдельного runtime-разрешения: согласие даётся системным диалогом
        // «Добавить VPN-конфигурацию» при saveToPreferences в startVpnWithResult.
        call.resolve(["result": true])
    }

    @objc func requestAllPermissions(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
            call.resolve(["result": ["ok": true]])
        }
    }

    @objc func getBatteryStatus(_ call: CAPPluginCall) {
        // iOS не раскрывает заряд/режим экономии приложению: Doze не применим.
        call.resolve(["result": ["doze": false, "manufacturer": "Apple"]])
    }

    @objc func requestDozeExemption(_ call: CAPPluginCall) {
        call.resolve(["result": ["ok": true]])
    }

    @objc func requestOemBatterySettings(_ call: CAPPluginCall) {
        call.resolve(["result": ["ok": true]])
    }

    @objc func checkTorPort(_ call: CAPPluginCall) {
        call.resolve(["result": ["available": false]])
    }

    @objc func openOrbotInstall(_ call: CAPPluginCall) {
        call.resolve(["result": false])
    }

    @objc func getPendingDeepLink(_ call: CAPPluginCall) {
        call.resolve(["result": AppDelegate.takePendingDeepLink() ?? ""])
    }

    // ── Информация ───────────────────────────────────────────────────────────

    @objc func getCoreVersions(_ call: CAPPluginCall) {
        // Ядро — Xray; sing-box/mihomo на iOS не поставляются (пустые значения
        // bridge.ts подставит дефолты только если ключ отсутствует, а пустая строка
        // пройдёт как есть — поэтому отдаём явные прочерки).
        call.resolve(["result": ["xray": "Xray-core", "singbox": "", "mihomo": ""]])
    }

    @objc func getSystemInfo(_ call: CAPPluginCall) {
        let info = ProcessInfo.processInfo
        call.resolve(["result": [
            "osVersion": UIDevice.current.systemVersion,
            "apiLevel": 0,
            "model": deviceModel(),
            "manufacturer": "Apple",
            "totalMemory": Int64(info.physicalMemory),
            "freeMemory": 0,
            "maxMemory": 0
        ]])
    }

    @objc func getAppVersion(_ call: CAPPluginCall) {
        let info = Bundle.main.infoDictionary ?? [:]
        call.resolve(["result": [
            "versionName": info["CFBundleShortVersionString"] as? String ?? "0",
            "versionCode": Int(info["CFBundleVersion"] as? String ?? "0") ?? 0
        ]])
    }

    @objc func getDeviceId(_ call: CAPPluginCall) {
        // identifierForVendor сбрасывается при удалении всех копий приложения —
        // bridge.ts проверяет формат UUID и вернёт null, если значение не подходит.
        if let id = UIDevice.current.identifierForVendor?.uuidString {
            call.resolve(["result": id.lowercased()])
        } else {
            call.resolve(["result": NSNull()])
        }
    }

    @objc func getLastError(_ call: CAPPluginCall) {
        call.resolve(["result": defaults.string(forKey: Keys.lastError) ?? ""])
    }

    @objc func getLogs(_ call: CAPPluginCall) {
        var lines: [String] = []
        stateQueue.sync { lines = logRing }
        // Сливаем журнал приложения с журналом расширения (если оно живо).
        loadManager { manager in
            guard let session = manager?.connection as? NETunnelProviderSession else {
                call.resolve(["result": lines.joined(separator: "\n")])
                return
            }
            do {
                try session.sendProviderMessage("{\"cmd\":\"logs\"}".data(using: .utf8)!) { data in
                    var ext = ""
                    if let data = data, let s = String(data: data, encoding: .utf8) { ext = s }
                    let all = lines + (ext.isEmpty ? [] : ext.components(separatedBy: "\n"))
                    call.resolve(["result": all.joined(separator: "\n")])
                }
            } catch {
                call.resolve(["result": lines.joined(separator: "\n")])
            }
        }
    }

    @objc func readClipboard(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["result": UIPasteboard.general.string ?? ""])
        }
    }

    // ── Сеть ─────────────────────────────────────────────────────────────────

    private let telephonyInfo = CTTelephonyNetworkInfo()

    @objc func getCurrentNetwork(_ call: CAPPluginCall) {
        let monitor = currentPathMonitor()
        let type = pathType(monitor.currentPath)
        call.resolve(["result": type])
    }

    @objc func isNetworkAvailable(_ call: CAPPluginCall) {
        call.resolve(["result": currentPathMonitor().currentPath.status == .satisfied])
    }

    @objc func getNetworkInfo(_ call: CAPPluginCall) {
        let path = currentPathMonitor().currentPath
        call.resolve(["result": [
            "type": pathType(path),
            "available": path.status == .satisfied,
            "carrier": currentCarrier()
        ]])
    }

    @objc func getCarrier(_ call: CAPPluginCall) {
        call.resolve(["result": currentCarrier()])
    }

    @objc func startNetworkMonitoring(_ call: CAPPluginCall) {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self = self else { return }
            let satisfied = path.status == .satisfied
            let carrier = self.currentCarrier()
            self.lastCarrier = carrier
            self.notifyListeners("network-changed", data: [
                "event": satisfied ? "changed" : "unavailable",
                "type": self.pathType(path),
                "carrier": carrier
            ])
        }
        monitor.start(queue: .global(qos: .utility))
        pathMonitor = monitor
        call.resolve(["result": ["ok": true]])
    }

    @objc func stopNetworkMonitoring(_ call: CAPPluginCall) {
        pathMonitor?.cancel()
        pathMonitor = nil
        call.resolve(["result": ["ok": true]])
    }

    private func currentPathMonitor() -> NWPathMonitor {
        if let monitor = pathMonitor { return monitor }
        let monitor = NWPathMonitor()
        pathMonitor = monitor
        return monitor
    }

    private func pathType(_ path: Network.NWPath) -> String {
        if path.usesInterfaceType(.wifi) { return "WIFI" }
        if path.usesInterfaceType(.cellular) { return "CELLULAR" }
        if path.usesInterfaceType(.wiredEthernet) { return "ETHERNET" }
        return path.status == .satisfied ? "OTHER" : "NONE"
    }

    private func currentCarrier() -> String {
        if let carriers = telephonyInfo.serviceSubscriberCellularProviders {
            for (_, provider) in carriers {
                if let name = provider.carrierName, !name.isEmpty { return name }
            }
        }
        return lastCarrier
    }

    // ── UI-обвязка ───────────────────────────────────────────────────────────

    @objc func showNotification(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? ""
        let body = call.getString("body") ?? ""
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
        call.resolve(["result": ["ok": true]])
    }

    /// iOS не разрешает менять цвет статус-бара программно — молча принимаем.
    @objc func setStatusBarColor(_ call: CAPPluginCall) {
        call.resolve(["result": ["ok": true]])
    }

    @objc func setStatusBarStyle(_ call: CAPPluginCall) {
        // iOS задаёт стиль статус-бара через Info.plist/UIViewControllerBasedStatusBarAppearance.
        // Явный программный смена стиля не поддерживается — принимаем и подтверждаем,
        // чтобы bridge.ts не считал вызов сбоем.
        DispatchQueue.main.async {
            UIApplication.shared.isStatusBarHidden = false
            call.resolve(["result": ["ok": true]])
        }
    }

    @objc func minimizeApp(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // Приватный селектор suspend — единственный способ свернуть приложение
            // программно на iOS. Если Apple его уберёт, вызов просто не сработает.
            let app = UIApplication.shared
            if app.responds(to: Selector(("suspend"))) {
                app.perform(Selector(("suspend")))
            }
            call.resolve(["result": ["ok": true]])
        }
    }

    @objc func clearDnsCache(_ call: CAPPluginCall) {
        // iOS сама чистит DNS-кеш; явного API нет.
        call.resolve(["result": ["ok": true]])
    }

    @objc func openUrl(_ call: CAPPluginCall) {
        guard let urlStr = call.getString("url"), let url = URL(string: urlStr) else {
            call.resolve(["result": ["ok": false]])
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { ok in
                call.resolve(["result": ["ok": ok]])
            }
        }
    }

    @objc func vibrate(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
            call.resolve(["result": ["ok": true]])
        }
    }

    // ── Batch-пинг (событиями ping-batch-item / ping-batch-done) ─────────────

    @objc func pingBatch(_ call: CAPPluginCall) {
        let serversJson = call.getString("servers") ?? "[]"
        let taskId = call.getString("taskId") ?? ""
        guard let data = serversJson.data(using: .utf8),
              let servers = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            notifyListeners("ping-batch-done", data: ["taskId": taskId])
            call.resolve(["result": ["ok": false]])
            return
        }
        pingCancelled = false
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            for (index, server) in servers.enumerated() {
                if self.pingCancelled { break }
                let id = server["id"] as? String ?? ""
                let config = server["config"] as? String ?? ""
                let ms = self.measureServer(configJson: config)
                self.notifyListeners("ping-batch-item", data: [
                    "id": id, "ms": ms, "i": index, "n": servers.count, "taskId": taskId
                ])
            }
            self.notifyListeners("ping-batch-done", data: ["taskId": taskId])
            DispatchQueue.main.async { call.resolve(["result": ["ok": true]]) }
        }
    }

    @objc func cancelPingBatch(_ call: CAPPluginCall) {
        pingCancelled = true
        call.resolve(["result": ["ok": true]])
    }

    private func measureServer(configJson: String) -> Double {
        guard let endpoint = SimXrayConfig.extractOutboundEndpoint(configJson) else { return -1 }
        var measured: Double = -1
        let sem = DispatchSemaphore(value: 0)
        tcpProbe(host: endpoint.host, port: endpoint.port, timeoutMs: 5000) { result in
            measured = (result["ok"] as? Bool == true) ? (result["ms"] as? Double ?? -1) : -1
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 6)
        return measured
    }

    // ── TCP-пробы (NWConnection) ─────────────────────────────────────────────

    /// DNS → TCP-соединение → измерение. IPv4 предпочтительнее IPv6 (как на Android).
    private func tcpProbe(host: String, port: Int, timeoutMs: Int, completion: @escaping ([String: Any]) -> Void) {
        guard !host.isEmpty, port > 0 else {
            completion(["ok": false, "stage": "tcp", "error": "bad-args"])
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let start = DispatchTime.now()
            let hostObj = NWEndpoint.Host(host)
            let endpoint = NWEndpoint.hostPort(host: hostObj, port: NWEndpoint.Port(rawValue: UInt16(port)) ?? .https)
            let connection = NWConnection(to: endpoint, using: .tcp)
            var settled = false
            let settle = { (result: [String: Any]) in
                // NWConnection может дозваниваться после таймаута — принимаем первый исход.
                if settled { return }
                settled = true
                connection.cancel()
                completion(result)
            }
            let timeout = DispatchTime.now() + .milliseconds(timeoutMs)
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: timeout) {
                settle(["ok": false, "stage": "tcp", "error": "timeout"])
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    let ms = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000.0
                    settle(["ok": true, "ms": ms, "ip": host])
                case .failed(let error):
                    settle(["ok": false, "stage": "tcp", "error": SimErrorSanitizer.tcpStage(error)])
                case .cancelled:
                    settle(["ok": false, "stage": "tcp", "error": "cancelled"])
                default:
                    break
                }
            }
            connection.start(queue: .global(qos: .userInitiated))
        }
    }

    // ── Вспомогательное ──────────────────────────────────────────────────────

    private func deviceModel() -> String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let mirror = Mirror(reflecting: systemInfo.machine)
        let identifier = mirror.children.reduce("") { acc, element in
            guard let value = element.value as? Int8, value != 0 else { return acc }
            return acc + String(UnicodeScalar(UInt8(value)))
        }
        return identifier.isEmpty ? "iPhone" : identifier
    }
}
