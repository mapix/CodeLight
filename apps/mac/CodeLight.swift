import AppKit
import SwiftUI
import CoreImage.CIFilterBuiltins

// BEGIN CODELIGHT DASHBOARD VALUES
enum DashboardPanel: String, CaseIterable { case statistics, pairing }

struct DashboardSelection: Equatable {
    private(set) var panel: DashboardPanel = .pairing
    private var userSelected = false
    private var pairedDefaultApplied = false

    mutating func select(_ value: DashboardPanel) { panel = value; userSelected = true }
    mutating func receivePairedDevices(_ hasPairedDevices: Bool) {
        guard hasPairedDevices, !pairedDefaultApplied else { return }
        pairedDefaultApplied = true
        if !userSelected { panel = .statistics }
    }
}

struct DashboardMetrics: Decodable, Equatable {
    let receivedBytes: Double?
    let sentBytes: Double?
    let totalReceivedBytes: Double?
    let totalSentBytes: Double?
    let receiveBytesPerSecond: Double?
    let sendBytesPerSecond: Double?
    let httpRequests: Double?
    let rpcRequests: Double?
    let connectedDevices: Double?
    let uptimeMs: Double?

    private enum CodingKeys: String, CodingKey {
        case version, receivedBytes, sentBytes, totalReceivedBytes, totalSentBytes
        case receiveBytesPerSecond, sendBytesPerSecond, httpRequests, rpcRequests, connectedDevices, uptimeMs
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        if values.contains(.version), (try? values.decode(Int.self, forKey: .version)) != 1 {
            throw DecodingError.dataCorruptedError(forKey: .version, in: values, debugDescription: "Unsupported metrics version")
        }
        func measured(_ key: CodingKeys, integer: Bool = true) -> Double? {
            guard let number = try? values.decode(Double.self, forKey: key), number.isFinite, number >= 0,
                  !integer || number.rounded(.down) == number else { return nil }
            return number
        }
        receivedBytes = measured(.receivedBytes); sentBytes = measured(.sentBytes)
        totalReceivedBytes = measured(.totalReceivedBytes); totalSentBytes = measured(.totalSentBytes)
        receiveBytesPerSecond = measured(.receiveBytesPerSecond, integer: false)
        sendBytesPerSecond = measured(.sendBytesPerSecond, integer: false)
        httpRequests = measured(.httpRequests); rpcRequests = measured(.rpcRequests)
        connectedDevices = measured(.connectedDevices); uptimeMs = measured(.uptimeMs)
    }
    var hasMeasurements: Bool {
        [receivedBytes, sentBytes, totalReceivedBytes, totalSentBytes, receiveBytesPerSecond,
         sendBytesPerSecond, httpRequests, rpcRequests, connectedDevices, uptimeMs].contains { $0 != nil }
    }
}

enum DashboardFormat {
    static let unmeasured = "—"
    static func bytes(_ value: Double?, perSecond: Bool = false, locale: Locale = .current) -> String {
        guard let value, value.isFinite, value >= 0 else { return unmeasured }
        let units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"]
        var amount = value, unit = 0
        while amount >= 1024, unit < units.count - 1 { amount /= 1024; unit += 1 }
        let formatter = NumberFormatter(); formatter.locale = locale; formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = unit == 0 && !perSecond ? 0 : 1
        guard let number = formatter.string(from: NSNumber(value: amount)) else { return unmeasured }
        return "\(number) \(units[unit])" + (perSecond ? NSLocalizedString("/s", comment: "Bytes per second unit") : "")
    }
    static func count(_ value: Double?, locale: Locale = .current) -> String {
        guard let value, value.isFinite, value >= 0, value.rounded(.down) == value else { return unmeasured }
        let formatter = NumberFormatter(); formatter.locale = locale; formatter.numberStyle = .decimal; formatter.maximumFractionDigits = 0
        return formatter.string(from: NSNumber(value: value)) ?? unmeasured
    }
    static func uptime(_ milliseconds: Double?) -> String {
        guard let milliseconds, milliseconds.isFinite, milliseconds >= 0 else { return unmeasured }
        let formatter = DateComponentsFormatter(); formatter.allowedUnits = [.hour, .minute, .second]
        formatter.unitsStyle = .abbreviated; formatter.zeroFormattingBehavior = .pad
        return formatter.string(from: milliseconds / 1000) ?? unmeasured
    }
}
// END CODELIGHT DASHBOARD VALUES

// BEGIN CODELIGHT CONNECTION VALUES
struct ConnectionConfiguration: Decodable, Equatable {
    let enabledChannels: [String]
    let relayConfigured: Bool
    let serverUrl: String
    let hasToken: Bool
    static let unknown = ConnectionConfiguration(enabledChannels: [], relayConfigured: false, serverUrl: "", hasToken: false)
    var availableKinds: [String] { ["local", "cloudflare"] + (relayConfigured ? ["relay"] : []) }
    var enabledKinds: Set<String> { Set(enabledChannels).intersection(Set(availableKinds)) }
}

struct ConnectionChannel: Identifiable, Decodable, Equatable {
    let id: String
    let kind: String
    let url: String
    let label: String?
    let state: String
    var displayLabel: String { label ?? (kind == "local" ? "Local network" : kind == "cloudflare" ? "Cloudflare" : "Relay") }
}

enum ConnectionStatus {
    static func label(kind: String, configuration: ConnectionConfiguration, channels: [ConnectionChannel]) -> String {
        guard configuration.enabledKinds.contains(kind) else { return "Off" }
        let states = channels.filter { $0.kind == kind }.map { $0.state }
        if states.contains("ready") { return "Ready" }
        if states.contains("starting") { return "Starting…" }
        if states.contains("reconnecting") { return "Reconnecting…" }
        if states.contains("unverified") { return "Not verified yet" }
        return "Unavailable"
    }
}
// END CODELIGHT CONNECTION VALUES

// BEGIN CODELIGHT SERVICE VALUES
enum ServicePhase: String { case starting, running, pausing, paused, failed
    var canStart: Bool { self == .paused || self == .failed }
    var canPause: Bool { self == .starting || self == .running }
    var running: Bool { self == .starting || self == .running }
    func terminated() -> ServicePhase { self == .pausing ? .paused : .failed }
}
// END CODELIGHT SERVICE VALUES

@MainActor
final class DashboardMetricsStore: ObservableObject {
    @Published private(set) var value: DashboardMetrics?
    func receive(_ raw: Any) {
        guard let bytes = try? JSONSerialization.data(withJSONObject: raw), let next = try? JSONDecoder().decode(DashboardMetrics.self, from: bytes) else { value = nil; return }
        value = next
    }
    func reset() { value = nil }
}

@MainActor
final class ServiceController: ObservableObject {
    struct Device: Identifiable, Codable, Equatable { var id: String; var name: String; var createdAt: Double; var lastSeen: Double; var revoked: Bool; var connected: Bool }
    @Published var status = "Starting CodeLight…"
    @Published var pairingURL = ""
    @Published var origin = ""
    @Published private(set) var phase: ServicePhase = .paused
    var running: Bool { phase.running }
    @Published var devices: [Device] = []
    @Published var notificationsAvailable = false
    @Published var copied = false
    @Published var operationError = ""
    @Published private(set) var connectionConfiguration = ConnectionConfiguration.unknown
    @Published private(set) var connectionChannels: [ConnectionChannel] = []
    @Published private(set) var connectionConfigurationKnown = false
    @Published private(set) var channelsBusy = false
    @Published private(set) var channelsError = ""
    @Published var relayServer = ""
    @Published var relayKey = ""
    @Published var accessBusy = false
    var accessHasSavedKey: Bool { connectionConfiguration.hasToken }
    @Published var accessError = ""
    private var accessRequestID = ""
    private var channelsRequestID = ""
    @Published private(set) var selection = DashboardSelection()
    @Published private var cachedPairingImage: NSImage?
    let metrics = DashboardMetricsStore()
    private var imageURL = ""
    private lazy var imageContext = CIContext()
    private var process: Process?
    private var input: Pipe?
    private var buffer = Data()

    func start() {
        guard process == nil else { return }
        guard let resources = Bundle.main.resourceURL else { return }
        let runtime = resources.appendingPathComponent("runtime")
        let state = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("CodeLight")
        let task = Process(), output = Pipe(), errors = Pipe(), stdin = Pipe()
        task.executableURL = runtime.appendingPathComponent("node")
        task.arguments = [runtime.appendingPathComponent("src/happy/mac-app-service.mjs").path, "--state=\(state.path)"]
        task.currentDirectoryURL = runtime
        task.standardOutput = output; task.standardError = errors; task.standardInput = stdin
        task.environment = ProcessInfo.processInfo.environment.merging(["PATH": runtime.path + ":/usr/bin:/bin:/usr/sbin:/sbin"]) { _, new in new }
        output.fileHandleForReading.readabilityHandler = { [weak self, weak task] handle in
            let bytes = handle.availableData
            guard !bytes.isEmpty else { return }
            DispatchQueue.main.async {
                // 旧服务的迟到 stdout 不得覆盖新 Process 的通道状态或二维码。
                guard let self, let task, self.process === task else { return }
                self.receive(bytes)
            }
        }
        errors.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        task.terminationHandler = { [weak self] terminated in
            DispatchQueue.main.async {
                guard let self, self.process === terminated else { return }
                self.phase = self.phase.terminated()
                self.process = nil; self.input = nil; self.pairingURL = ""; self.origin = ""
                self.status = self.phase == .paused ? "Paused" : "Connection unavailable"
                self.metrics.reset()
                self.resetConnectionObservation()
            }
        }
        process = task; input = stdin; phase = .starting; buffer.removeAll(); status = "Starting CodeLight…"; metrics.reset(); resetConnectionObservation()
        do { try task.run() } catch { process = nil; input = nil; phase = .failed; status = "Connection unavailable" }
    }
    private func receive(_ bytes: Data) {
        // 暂停等待完整子进程清理期间，迟到消息不能把用户主动暂停重新显示为连接就绪。
        guard phase != .pausing else { return }
        buffer.append(bytes)
        if buffer.count > 65536 { buffer.removeAll(); return }
        while let end = buffer.firstIndex(of: 10) {
            let line = buffer.prefix(upTo: end); buffer.removeSubrange(...end)
            guard let item = try? JSONSerialization.jsonObject(with: line) as? [String: Any], let type = item["type"] as? String else { continue }
            if type == "ready", let value = item["pairingUrl"] as? String {
                phase = .running
                pairingURL = value; origin = item["origin"] as? String ?? ""
                status = devices.contains { !$0.revoked } ? "Connection ready" : "Ready to scan"
            } else if type == "access-configuration", let raw = item["configuration"],
                      let bytes = try? JSONSerialization.data(withJSONObject: raw),
                      let configuration = try? JSONDecoder().decode(ConnectionConfiguration.self, from: bytes) {
                let previousServer = connectionConfiguration.serverUrl
                connectionConfiguration = configuration; connectionConfigurationKnown = true
                // 通道勾选回执不能覆盖用户正在编辑的另一个 Relay 地址草稿。
                if !accessBusy, relayServer.isEmpty || relayServer == previousServer { relayServer = configuration.serverUrl }
            } else if type == "access-channels", let raw = item["channels"],
                      let bytes = try? JSONSerialization.data(withJSONObject: raw),
                      let channels = try? JSONDecoder().decode([ConnectionChannel].self, from: bytes) {
                let safeChannels = channels.filter { ["local", "cloudflare", "relay"].contains($0.kind) }
                if connectionChannels != safeChannels { connectionChannels = safeChannels }
                if item["overallState"] as? String == "unavailable", pairingURL.isEmpty { status = "Connection unavailable" }
            } else if type == "access-result", let requestID = item["requestId"] as? String {
                if requestID == channelsRequestID {
                    channelsBusy = false
                    channelsError = item["ok"] as? Bool == true ? "" : "Could not update connection channels. Try again."
                } else if requestID == accessRequestID {
                    accessBusy = false
                    if item["ok"] as? Bool == true { relayKey = ""; accessError = ""; relayServer = connectionConfiguration.serverUrl }
                    else { accessError = "Could not validate the Relay connection. Check address, access key and network." }
                }
            } else if type == "metrics" {
                // 每秒小样本只通知指标视图，不能使设备输入框和隐藏二维码重新计算。
                if let raw = item["metrics"] { metrics.receive(raw) } else { metrics.reset() }
            } else if type == "devices", let data = item["devices"], let bytes = try? JSONSerialization.data(withJSONObject: data), let rows = try? JSONDecoder().decode([Device].self, from: bytes) {
                if rows != devices { devices = rows }
                var next = selection; next.receivePairedDevices(rows.contains { !$0.revoked })
                if next != selection { selection = next }
                if !origin.isEmpty, rows.contains(where: { !$0.revoked }) { status = "Connection ready" }
                operationError = ""
            } else if type == "diagnostic", item["code"] as? String == "device-operation-failed" {
                operationError = "Could not update device. Try again."
            } else if type == "notifications" {
                notificationsAvailable = item["available"] as? Bool ?? false
            } else if type == "error" {
                pairingURL = ""; status = "Connection unavailable"; metrics.reset(); resetConnectionObservation()
            } else if type == "starting" { status = item["phase"] as? String == "public-connection" ? "Connecting from anywhere…" : "Starting CodeLight…" }
        }
    }
    private func resetConnectionObservation() {
        connectionChannels = []; connectionConfigurationKnown = false; channelsBusy = false; accessBusy = false
        channelsRequestID = ""; accessRequestID = ""
    }
    func selectPanel(_ panel: DashboardPanel) { selection.select(panel) }
    var publicStatus: String {
        if phase == .pausing { return "Pausing…" }
        if phase == .paused { return "Paused" }
        if phase == .failed { return "Connection unavailable" }
        if connectionConfigurationKnown && connectionConfiguration.enabledKinds.isEmpty { return "All connections are off" }
        if !connectionChannels.contains(where: { $0.state == "ready" }) {
            if connectionChannels.contains(where: { $0.state == "reconnecting" }) { return "Reconnecting…" }
            if connectionChannels.contains(where: { $0.state == "unverified" }) { return "Waiting for connection verification…" }
            if !connectionChannels.isEmpty && connectionChannels.allSatisfy({ $0.state == "unavailable" }) { return "Connection unavailable" }
        }
        return status
    }
    func refresh() { try? input?.fileHandleForWriting.write(contentsOf: Data("{\"type\":\"refresh-invite\"}\n".utf8)) }
    func deviceAction(_ type: String, id: String, name: String? = nil) {
        var value = ["type": type, "id": id]; if let name = name { value["name"] = name }
        guard var bytes = try? JSONSerialization.data(withJSONObject: value) else { return }; bytes.append(10)
        try? input?.fileHandleForWriting.write(contentsOf: bytes)
    }
    func stop() {
        guard phase.canPause, let process else { return }
        // 复用服务的 graceful shutdown；Start 只有在 terminationHandler 确认所有 owned writer 退出后才开放。
        phase = .pausing; pairingURL = ""; status = "Pausing…"; process.terminate()
    }
    func setChannel(_ kind: String, enabled: Bool) {
        guard !channelsBusy, connectionConfigurationKnown, connectionConfiguration.availableKinds.contains(kind), let input else { return }
        var selected = connectionConfiguration.enabledKinds
        if enabled { selected.insert(kind) } else { selected.remove(kind) }
        channelsRequestID = UUID().uuidString
        let value: [String: Any] = ["type": "set-enabled-channels", "requestId": channelsRequestID, "channels": ["local", "cloudflare", "relay"].filter { selected.contains($0) }]
        guard var bytes = try? JSONSerialization.data(withJSONObject: value) else { return }; bytes.append(10)
        channelsBusy = true; channelsError = ""
        do { try input.fileHandleForWriting.write(contentsOf: bytes) }
        catch { channelsBusy = false; channelsError = "Could not update connection channels. Try again." }
    }
    func configureRelay() {
        guard !accessBusy, let input else { return }
        accessRequestID = UUID().uuidString
        var value = ["type": "configure-relay", "requestId": accessRequestID, "serverUrl": relayServer]
        if !relayKey.isEmpty { value["token"] = relayKey }
        guard var bytes = try? JSONSerialization.data(withJSONObject: value) else { return }; bytes.append(10)
        accessBusy = true; accessError = ""
        do { try input.fileHandleForWriting.write(contentsOf: bytes) }
        catch { accessBusy = false; accessError = "Could not validate the Relay connection. Check address, access key and network." }
    }
    func copyLink() {
        NSPasteboard.general.clearContents(); copied = NSPasteboard.general.setString(pairingURL, forType: .string)
        Task { try? await Task.sleep(nanoseconds: 2_000_000_000); copied = false }
    }
    var image: NSImage? { imageURL == pairingURL ? cachedPairingImage : nil }
    func preparePairingImage() {
        guard imageURL != pairingURL else { return }
        imageURL = pairingURL; cachedPairingImage = nil
        guard !pairingURL.isEmpty else { return }
        let filter = CIFilter.qrCodeGenerator(); filter.message = Data(pairingURL.utf8); filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = imageContext.createCGImage(output, from: output.extent) else { return }
        cachedPairingImage = NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
    }

    #if DEBUG
    static func preview(paired: Bool) -> ServiceController {
        let service = ServiceController()
        service.phase = .running; service.status = paired ? "Connection ready" : "Ready to scan"
        service.pairingURL = "codelight://preview/not-a-pairing-invitation"
        if paired {
            let now = Date().timeIntervalSince1970 * 1000
            service.devices = [Device(id: "preview-phone", name: "Preview phone", createdAt: now, lastSeen: now, revoked: false, connected: true)]
            service.selection.receivePairedDevices(true)
            service.metrics.receive(["version": 1, "receivedBytes": 1048576, "sentBytes": 65536,
                                     "totalReceivedBytes": 12582912, "totalSentBytes": 4194304,
                                     "receiveBytesPerSecond": 2048, "sendBytesPerSecond": 512,
                                     "httpRequests": 42, "rpcRequests": 7, "connectedDevices": 1, "uptimeMs": 90000])
        }
        return service
    }
    #endif
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let service = ServiceController()
    func applicationDidFinishLaunching(_ notification: Notification) { service.start(); NSApp.activate(ignoringOtherApps: true) }
    func applicationWillTerminate(_ notification: Notification) { service.stop() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

struct ContentView: View {
    @ObservedObject var service: ServiceController
    var body: some View {
        ScrollView { VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 12) {
                Image("brand-icon").resizable().frame(width: 36, height: 36).clipShape(RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 3) {
                    Text("CodeLight").font(.system(size: 25, weight: .semibold))
                    Text("Your existing Codex sessions on your phone").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text(LocalizedStringKey(service.publicStatus)).font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                Button("Start", systemImage: "play.fill") { service.start() }
                    .disabled(!service.phase.canStart).accessibilityIdentifier("codelight-service-start")
                Button("Pause", systemImage: "pause.fill") { service.stop() }
                    .disabled(!service.phase.canPause).accessibilityIdentifier("codelight-service-pause")
                if service.phase == .pausing { ProgressView().controlSize(.small) }
            }
            Label("Only desktop Codex connected through gateway mode is supported.", systemImage: "info.circle")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Picker("View", selection: Binding(get: { service.selection.panel }, set: { service.selectPanel($0) })) {
                Text("Statistics").tag(DashboardPanel.statistics)
                Text("Pairing").tag(DashboardPanel.pairing)
            }.pickerStyle(.segmented).labelsHidden()
            if service.selection.panel == .statistics {
                StatisticsView(metrics: service.metrics, running: service.running)
            } else {
                PairingView(service: service)
            }
            Divider()
            PublicAccessView(service: service)
            Divider()
            DevicesView(service: service)
        }.padding(28).frame(maxWidth: 700) }.frame(minWidth: 560, minHeight: 700)
    }
}

struct PublicAccessView: View {
    @ObservedObject var service: ServiceController
    @State private var relayExpanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connections").font(.headline)
            ForEach(service.connectionConfiguration.availableKinds, id: \.self) { kind in
                HStack(alignment: .top, spacing: 14) {
                    Toggle(isOn: Binding(get: { service.connectionConfiguration.enabledKinds.contains(kind) }, set: { service.setChannel(kind, enabled: $0) })) {
                        Text(LocalizedStringKey(kind == "local" ? "Local network" : kind == "cloudflare" ? "Cloudflare" : "Relay"))
                    }.toggleStyle(.checkbox).accessibilityIdentifier("codelight-channel-\(kind)")
                        .disabled(service.channelsBusy || !service.running || !service.connectionConfigurationKnown)
                    Spacer()
                    Text(LocalizedStringKey(service.phase == .paused || service.phase == .pausing ? service.publicStatus : service.connectionConfigurationKnown ? ConnectionStatus.label(kind: kind, configuration: service.connectionConfiguration, channels: service.connectionChannels) : "Starting…"))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Text("The phone chooses an available connection. You can switch connections there anytime.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if service.connectionChannels.contains(where: { $0.state == "unverified" }) {
                Text("An address is waiting for verification. The phone can check it when connecting.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if !service.channelsError.isEmpty { Text(LocalizedStringKey(service.channelsError)).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            DisclosureGroup("Configure Relay", isExpanded: $relayExpanded) {
                VStack(alignment: .leading, spacing: 12) {
                    TextField("Relay server address", text: $service.relayServer, prompt: Text("https://relay.example.com"))
                        .textFieldStyle(.roundedBorder).disabled(service.accessBusy)
                    SecureField("Access key", text: $service.relayKey).textFieldStyle(.roundedBorder).disabled(service.accessBusy)
                    if service.accessHasSavedKey, service.relayServer == service.connectionConfiguration.serverUrl { Text("Saved key will be reused for this server.").font(.caption).foregroundStyle(.secondary) }
                    HStack {
                        Button("Validate & save Relay") { service.configureRelay() }.disabled(service.accessBusy || !service.running || service.relayServer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("codelight-configure-relay")
                        if service.accessBusy { ProgressView().controlSize(.small); Text("Validating Relay…").font(.caption) }
                    }
                    if !service.accessError.isEmpty { Text(LocalizedStringKey(service.accessError)).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
                }.padding(.top, 12)
            }
        }
    }
}

struct StatisticsView: View {
    @ObservedObject var metrics: DashboardMetricsStore
    let running: Bool
    var body: some View {
        let value = metrics.value
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 14) {
                Text("Gateway traffic").font(.headline)
                HStack(spacing: 20) {
                    RateValue(label: "Receiving", symbol: "arrow.down", value: running ? value?.receiveBytesPerSecond : nil)
                    Divider()
                    RateValue(label: "Sending", symbol: "arrow.up", value: running ? value?.sendBytesPerSecond : nil)
                }.frame(height: 66)
            }.padding(18).background(Color(nsColor: .controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 12))
            HStack(alignment: .top, spacing: 14) {
                ByteTotals(title: "This connection", received: value?.receivedBytes, sent: value?.sentBytes)
                ByteTotals(title: "All time", received: value?.totalReceivedBytes, sent: value?.totalSentBytes)
            }
            Grid(horizontalSpacing: 18, verticalSpacing: 12) {
                GridRow {
                    SmallMetric(label: "HTTP requests", value: DashboardFormat.count(value?.httpRequests))
                    SmallMetric(label: "RPC calls", value: DashboardFormat.count(value?.rpcRequests))
                    SmallMetric(label: "Connected devices", value: DashboardFormat.count(value?.connectedDevices))
                    SmallMetric(label: "Uptime", value: DashboardFormat.uptime(value?.uptimeMs))
                }
            }.frame(maxWidth: .infinity)
            Text(LocalizedStringKey(value?.hasMeasurements == true ? "Gateway traffic measured by CodeLight. — means not measured." : "Waiting for gateway measurements…"))
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct RateValue: View {
    let label: String
    let symbol: String
    let value: Double?
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(LocalizedStringKey(label), systemImage: symbol).font(.caption).foregroundStyle(.secondary)
            Text(DashboardFormat.bytes(value, perSecond: true)).font(.system(size: 27, weight: .medium, design: .monospaced))
                .monospacedDigit().lineLimit(1).minimumScaleFactor(0.7).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct ByteTotals: View {
    let title: String
    let received: Double?
    let sent: Double?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(LocalizedStringKey(title)).font(.subheadline).fontWeight(.semibold)
            LabeledContent("Received", value: DashboardFormat.bytes(received))
            LabeledContent("Sent", value: DashboardFormat.bytes(sent))
        }.font(.callout).monospacedDigit().padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

struct SmallMetric: View {
    let label: String
    let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(LocalizedStringKey(label)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            Text(value).font(.system(size: 17, weight: .medium, design: .monospaced)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.75)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct PairingView: View {
    @ObservedObject var service: ServiceController
    var body: some View {
        VStack(spacing: 16) {
            if let image = service.image {
                Image(nsImage: image).interpolation(.none).resizable().aspectRatio(contentMode: .fit)
                    .padding(20).background(.white).clipShape(RoundedRectangle(cornerRadius: 16)).frame(width: 300, height: 300)
            } else { ProgressView().frame(width: 300, height: 300) }
            Text("Open CodeLight on your phone and scan this code. No registration or VPN needed.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary).frame(maxWidth: 400)
            HStack {
                Button(LocalizedStringKey(service.copied ? "Copied" : "Copy pairing link")) { service.copyLink() }.disabled(service.pairingURL.isEmpty)
                Button("Refresh QR") { service.refresh() }.disabled(service.pairingURL.isEmpty)
            }
            Text("The phone keeps all enabled addresses. If addresses change and reconnection fails, scan the current QR code.")
                .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 430)
        }.frame(maxWidth: .infinity)
            .onAppear { service.preparePairingImage() }
            .onChange(of: service.pairingURL) { _, _ in service.preparePairingImage() }
    }
}

struct DevicesView: View {
    @ObservedObject var service: ServiceController
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Paired devices").font(.headline)
                Spacer()
                Text(LocalizedStringKey(service.notificationsAvailable ? "Notifications configured" : "Notifications need setup"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !service.operationError.isEmpty { Text(LocalizedStringKey(service.operationError)).font(.caption).foregroundStyle(.red) }
            if service.devices.isEmpty { Text("No devices yet").foregroundStyle(.secondary).font(.caption) }
            ScrollView { VStack(spacing: 10) {
                ForEach(service.devices) { device in DeviceRow(device: device, service: service) }
            } }.frame(maxHeight: 180)
        }
    }
}

struct DeviceRow: View {
    let device: ServiceController.Device
    let service: ServiceController
    @State private var name = ""
    @FocusState private var editing: Bool
    var body: some View {
        HStack {
            Image(systemName: "iphone").foregroundColor(device.revoked ? .secondary : .blue)
            VStack(alignment: .leading, spacing: 4) {
                TextField(device.name, text: $name, onCommit: { if !name.isEmpty { service.deviceAction("rename-device", id: device.id, name: name) } }).focused($editing)
                HStack { Text(LocalizedStringKey(device.revoked ? "Access removed" : device.connected ? "Connected" : "Offline")); Text(Date(timeIntervalSince1970: device.lastSeen / 1000), style: .relative) }.font(.caption).foregroundStyle(.secondary)
            }
            if !device.revoked { Button("Disconnect") { service.deviceAction("revoke-device", id: device.id) } }
        }.onAppear { name = device.name }.onChange(of: device.name) { _, value in if !editing { name = value } }
    }
}

@main
struct CodeLightApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    var body: some Scene {
        WindowGroup("CodeLight") { ContentView(service: delegate.service) }
            .defaultSize(width: 620, height: 820)
    }
}

#if DEBUG
@MainActor
struct CodeLightDashboardPreviews: PreviewProvider {
    static var previews: some View {
        Group {
            ContentView(service: ServiceController.preview(paired: true)).previewDisplayName("Paired statistics")
            ContentView(service: ServiceController.preview(paired: false)).previewDisplayName("First pairing")
        }
    }
}
#endif
