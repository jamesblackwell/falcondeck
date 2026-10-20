import AppKit
import CoreImage.CIFilterBuiltins
import SwiftUI

struct NativeRemoteSettingsView: View {
    let store: AppStore
    @State private var status: JSON = .null
    @State private var busy = false
    @State private var error: String?
    @State private var pendingDevice: JSON?
    @State private var relay = "https://connect.falcondeck.com"

    private var pairingCode: String { status["pairing"]["pairing_code"].string }
    private var pairingLink: String {
        guard !pairingCode.isEmpty else { return "" }
        var link = URLComponents(string: "https://falcondeck.com/pair")!
        link.queryItems = [URLQueryItem(name: "code", value: pairingCode)]
        let url = status["relay_url"].string
        if !url.isEmpty && url != "https://connect.falcondeck.com" { link.queryItems?.append(URLQueryItem(name: "relay", value: url)) }
        return link.url?.absoluteString ?? ""
    }

    var body: some View {
        Form {
            Section {
                HStack {
                    Label(remoteLabel(status["status"].string), systemImage: status["presence"]["daemon_connected"].bool ? "checkmark.shield" : "network")
                    Spacer()
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } }.disabled(busy)
                }
                Text("Pair a phone or browser to this Mac. Connections through the relay are end-to-end encrypted.")
                    .font(NativePreferences.shared.font(size: 13)).foregroundStyle(.secondary)
            } header: { Text("Remote access") }

            Section {
                HStack {
                    Button(pairingCode.isEmpty ? "Start pairing" : "Generate new pairing code", systemImage: "qrcode") {
                        Task { await startPairing() }
                    }.disabled(busy || !store.isConnected)
                    if busy { ProgressView().controlSize(.small) }
                }
                if !pairingCode.isEmpty {
                    HStack(alignment: .top, spacing: 22) {
                        if let qr = remoteQR(pairingLink) {
                            Image(nsImage: qr).interpolation(.none).resizable().frame(width: 136, height: 136)
                                .padding(8).background(.white, in: RoundedRectangle(cornerRadius: 8))
                                .accessibilityLabel("Scan with the FalconDeck mobile app to pair")
                        }
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Secure pairing code").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                            Text(pairingCode).font(NativePreferences.shared.font(size: 13, surface: "code")).textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                            HStack {
                                Button("Copy code") { remoteCopy(pairingCode) }
                                Button("Copy link") { remoteCopy(pairingLink) }
                            }
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                if let expiry = remoteDate(status["pairing"]["expires_at"].string) {
                                    if expiry > context.date {
                                        Text("Expires \(expiry, style: .relative) · connects one device").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                                    } else {
                                        Label("Expired — generate a new code", systemImage: "clock.badge.exclamationmark").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.orange)
                                    }
                                }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }.padding(.vertical, 8)
                } else {
                    Text("A pairing code is a temporary invitation. Generating another code keeps existing devices connected.")
                        .font(NativePreferences.shared.font(size: 13)).foregroundStyle(.secondary)
                }
                DisclosureGroup("Custom relay") {
                    TextField("Relay URL", text: $relay)
                    Text("Use your own HTTPS FalconDeck relay, or keep the hosted default.").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                }
            } header: { Text("Pair a new device") }

            Section {
                if status["trusted_devices"].array.isEmpty {
                    Text("No trusted devices yet. Pair a phone, tablet or browser to see it here.").foregroundStyle(.secondary)
                }
                ForEach(status["trusted_devices"].array, id: \.self) { device in
                    HStack(spacing: 12) {
                        Image(systemName: device["label"].string.lowercased().contains("phone") ? "iphone" : "desktopcomputer")
                            .font(.title3).foregroundStyle(.secondary).frame(width: 24)
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(device["label"].string.isEmpty ? "Unnamed device" : device["label"].string).fontWeight(.medium)
                                Text(remoteLabel(device["status"].string)).font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                            }
                            Text("Added \(remoteDisplayDate(device["created_at"].string)) · Last seen \(remoteDisplayDate(device["last_seen_at"].string))")
                                .font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Remove", role: .destructive) { pendingDevice = device }
                            .disabled(busy || device["status"].string == "revoked")
                    }.padding(.vertical, 4)
                }
            } header: { Text("Trusted devices") }

            Section {
                LabeledContent("Relay", value: status["relay_url"].string.isEmpty ? relay : status["relay_url"].string)
                LabeledContent("Desktop relay link", value: status["presence"]["daemon_connected"].bool ? "Online" : "Waiting")
                LabeledContent("Active trusted devices", value: "\(status["trusted_devices"].array.filter { $0["status"].string == "active" }.count)")
                LabeledContent("Last desktop seen", value: remoteDisplayDate(status["presence"]["last_seen_at"].string))
                if !status["last_error"].string.isEmpty {
                    Label(status["last_error"].string, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled)
                }
            } header: { Text("Connection status") }
            if let error { Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled) } }
        }
        .formStyle(.grouped)
        .task {
            await refresh()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(10)) } catch { return }
                if !busy { await refresh() }
            }
        }
        .confirmationDialog("Remove trusted device?", isPresented: Binding(get: { pendingDevice != nil }, set: { if !$0 { pendingDevice = nil } }), titleVisibility: .visible) {
            Button("Remove device", role: .destructive) {
                guard let device = pendingDevice else { return }
                pendingDevice = nil
                Task { await revoke(device) }
            }
        } message: { Text("This device will lose access to the Mac. It can be paired again using a new code.") }
    }

    @MainActor private func refresh() async {
        do {
            let initialLoad = status == .null
            status = try await store.request("/api/remote/status")
            if initialLoad && !status["relay_url"].string.isEmpty { relay = status["relay_url"].string }
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    @MainActor private func startPairing() async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            _ = try await store.request("/api/remote/pairing", method: "POST", body: .object(["relay_url": .string(relay.trimmingCharacters(in: .whitespacesAndNewlines))]))
            await refresh()
        } catch { self.error = error.localizedDescription }
    }

    @MainActor private func revoke(_ device: JSON) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            guard let id = device["device_id"].string.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#"))), !id.isEmpty else { return }
            _ = try await store.request("/api/remote/devices/\(id)", method: "DELETE")
            await refresh()
        } catch { self.error = error.localizedDescription }
    }
}

struct NativeServersSettingsView: View {
    let store: AppStore
    @State private var manager = NativeHostManager.shared
    @State private var showingAdd = false
    @State private var mode = "ssh"
    @State private var sshHosts: [JSON] = []
    @State private var selectedSSH = ""
    @State private var name = ""
    @State private var target = ""
    @State private var port = ""
    @State private var relay = "https://connect.falcondeck.com"
    @State private var pairingCode = ""
    @State private var job: JSON = .null
    @State private var busy = false
    @State private var error: String?
    @State private var notice: String?
    @State private var removeID: String?
    @State private var addingProjectID: String?
    @State private var projectPath = ""
    @State private var repairingID: String?
    @State private var repairCode = ""

    var body: some View {
        Form {
            Section {
                HStack {
                    Text("Run agents on remote machines. Sessions continue on the server while this Mac sleeps.")
                        .font(NativePreferences.shared.font(size: 13)).foregroundStyle(.secondary)
                    Spacer()
                    Button(showingAdd ? "Close" : "Add server", systemImage: showingAdd ? "xmark" : "plus") {
                        showingAdd.toggle(); error = nil; notice = nil
                    }.disabled(busy)
                }
                if showingAdd { addServer }
                if manager.hosts.isEmpty && !showingAdd {
                    Label("No servers yet. Add a server through SSH or use its secure pairing code.", systemImage: "server.rack")
                        .foregroundStyle(.secondary).padding(.vertical, 12)
                }
                ForEach(manager.hosts) { host in serverRow(host) }
            } header: { Text("Connected servers") }
            if let error { Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled) } }
            if let notice { Section { Label(notice, systemImage: "checkmark.circle").foregroundStyle(.secondary).textSelection(.enabled) } }
        }
        .formStyle(.grouped)
        .task { await loadSSHHosts() }
        .confirmationDialog("Remove this server?", isPresented: Binding(get: { removeID != nil }, set: { if !$0 { removeID = nil } }), titleVisibility: .visible) {
            Button("Remove server", role: .destructive) {
                guard let id = removeID else { return }
                removeID = nil
                Task { await perform { try await manager.remove(hostID: id) } }
            }
        } message: { Text("Its projects will leave the sidebar. The daemon and sessions keep running on the server.") }
    }

    private var addServer: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Connection method", selection: $mode) {
                Text("SSH config").tag("ssh")
                Text("Enter host").tag("manual")
                Text("Pairing code").tag("code")
            }.pickerStyle(.segmented)
            if mode == "ssh" {
                if sshHosts.isEmpty {
                    Text("No hosts found in ~/.ssh/config. Enter a host manually instead.").font(NativePreferences.shared.font(size: 13)).foregroundStyle(.secondary)
                } else {
                    Picker("SSH host", selection: $selectedSSH) {
                        Text("Choose a host").tag("")
                        ForEach(sshHosts, id: \.self) { host in Text(host["name"].string).tag(host["name"].string) }
                    }
                }
            } else {
                TextField("Display name", text: $name)
                if mode == "manual" {
                    TextField("SSH host (user@example.com)", text: $target)
                    TextField("SSH port (22)", text: $port)
                } else {
                    SecureField("Complete secure pairing code or link", text: $pairingCode)
                    Text("Use the complete code from the server daemon, including its authentication suffix.")
                        .font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                }
            }
            DisclosureGroup("Advanced: custom relay") { TextField("Relay URL", text: $relay) }
            if job != .null {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        if job["status"].string == "running" { ProgressView().controlSize(.small) }
                        Text(provisionStage(job["stage"].string)).font(NativePreferences.shared.font(size: 13))
                    }
                    if !job["log"].array.isEmpty {
                        Text(job["log"].array.suffix(6).map(\.string).joined(separator: "\n"))
                            .font(NativePreferences.shared.font(size: 11, surface: "code")).foregroundStyle(.secondary).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }.padding(.vertical, 6)
            }
            HStack {
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Button(mode == "code" ? "Connect" : "Install & connect") { Task { await connectServer() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || (mode == "code" ? pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty : mode == "ssh" ? selectedSSH.isEmpty : target.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) || (mode != "code" && !store.isConnected))
            }
        }.padding(.vertical, 8).disabled(busy)
    }

    @ViewBuilder private func serverRow(_ host: NativeRemoteHost) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Toggle("Enable \(host.name)", isOn: Binding(get: { host.enabled }, set: { enabled in
                    Task { await manager.setEnabled(hostID: host.id, enabled: enabled) }
                })).labelsHidden().toggleStyle(.switch).controlSize(.small)
                Image(systemName: "server.rack").foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(host.name).fontWeight(.medium)
                        Text(host.enabled ? host.status.label : "Disabled").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                    }
                    Text(host.sshTarget ?? host.relayURL).font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                }
                Spacer()
                Button { addingProjectID = addingProjectID == host.id ? nil : host.id; projectPath = "" } label: {
                    Image(systemName: "folder.badge.plus")
                }.help("Add project folder on this server").disabled(!host.enabled || host.status != .connected)
                Menu {
                    Button("Reconnect") { Task { await perform { try await manager.connect(hostID: host.id) } } }
                    if host.sshTarget != nil {
                        Button("Restart daemon") { Task { await runCommand(host, action: "restart") } }
                        Button("Re-pair through SSH") { Task { await runCommand(host, action: "pair") } }
                    }
                    Button("Enter new pairing code…") { repairingID = host.id; repairCode = "" }
                    Divider()
                    Button("Remove server…", role: .destructive) { removeID = host.id }
                } label: { Image(systemName: "ellipsis.circle") }.menuStyle(.borderlessButton).frame(width: 24)
            }
            if let message = host.error, host.enabled {
                Text(message).font(NativePreferences.shared.font(size: 11)).foregroundStyle(.orange).textSelection(.enabled)
            }
            if addingProjectID == host.id {
                HStack {
                    TextField("/home/user/projects/my-app", text: $projectPath).font(NativePreferences.shared.font(size: 13, surface: "code"))
                    Button("Add project") {
                        let path = projectPath.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task { await perform {
                            _ = try await manager.addProject(hostID: host.id, path: path)
                            addingProjectID = nil; projectPath = ""; notice = "Project added to \(host.name)."
                        } }
                    }.disabled(busy || projectPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            if repairingID == host.id {
                HStack {
                    SecureField("Complete pairing code or link", text: $repairCode)
                    Button("Cancel") { repairingID = nil; repairCode = "" }
                    Button("Re-pair") {
                        Task { await perform {
                            try await manager.repair(hostID: host.id, pairingText: repairCode, relay: host.relayURL)
                            repairingID = nil; repairCode = ""
                        } }
                    }.disabled(busy || repairCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }.padding(.vertical, 7)
    }

    @MainActor private func loadSSHHosts() async {
        do { sshHosts = try await store.request("/api/ssh/hosts")["hosts"].array }
        catch { self.error = error.localizedDescription }
    }

    @MainActor private func connectServer() async {
        let connectionMode = mode
        let hostTarget = (connectionMode == "ssh" ? selectedSSH : target).trimmingCharacters(in: .whitespacesAndNewlines)
        let hostName = connectionMode == "ssh" || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? hostTarget : name.trimmingCharacters(in: .whitespacesAndNewlines)
        let relayURL = relay.trimmingCharacters(in: .whitespacesAndNewlines)
        let hostPort = connectionMode == "ssh" ? (sshHosts.first { $0["name"].string == selectedSSH }?["port"].optionalInt ?? 22)
            : port.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 22 : Int(port)
        guard connectionMode == "code" || hostPort.map({ (1...65535).contains($0) }) == true else {
            error = "Enter an SSH port between 1 and 65535."; return
        }
        await perform {
            if connectionMode == "code" {
                _ = try await manager.addHost(name: name.isEmpty ? "Server" : name, pairingText: pairingCode, relay: relayURL)
            } else {
                job = .object(["status": .string("running"), "stage": .string("connecting")])
                let response = try await store.request("/api/hosts/provision", method: "POST", body: .object([
                    "ssh_target": .string(hostTarget), "name": .string(hostName), "relay_url": .string(relayURL), "port": .number(Double(hostPort ?? 22)),
                ]))
                guard !response["job_id"].string.isEmpty else { throw PilotError("The daemon did not return a provisioning job.") }
                let jobID = response["job_id"].string
                while true {
                    try await Task.sleep(for: .seconds(1))
                    try Task.checkCancellation()
                    job = try await store.request("/api/hosts/provision/\(jobID)")
                    if job["status"].string != "running" { break }
                }
                guard job["status"].string == "completed", !job["pairing_code"].string.isEmpty else {
                    throw PilotError(job["error"].string.isEmpty ? "Server provisioning failed." : job["error"].string)
                }
                _ = try await manager.addHost(name: hostName, pairingText: job["pairing_code"].string, relay: relayURL, sshTarget: hostTarget, sshPort: hostPort ?? 22)
            }
            showingAdd = false; pairingCode = ""; job = .null
            notice = "Server connected with end-to-end encryption."
        }
    }

    @MainActor private func runCommand(_ host: NativeRemoteHost, action: String) async {
        guard let target = host.sshTarget else { return }
        await perform {
            let result = try await store.request("/api/hosts/command", method: "POST", body: .object([
                "ssh_target": .string(target), "port": .number(Double(host.sshPort)), "action": .string(action), "relay_url": .string(host.relayURL),
            ]))
            if action == "pair" {
                guard !result["pairing_code"].string.isEmpty else { throw PilotError("The server did not return a pairing code.") }
                try await manager.repair(hostID: host.id, pairingText: result["pairing_code"].string, relay: host.relayURL)
                notice = "Re-paired \(host.name)."
            } else { notice = "Restarted the daemon on \(host.name)." }
        }
    }

    @MainActor private func perform(_ action: () async throws -> Void) async {
        guard !busy else { return }
        busy = true; error = nil; notice = nil
        defer { busy = false }
        do { try await action() }
        catch { self.error = error.localizedDescription }
    }

    private func provisionStage(_ value: String) -> String {
        switch value {
        case "connecting": "Connecting over SSH…"
        case "installing": "Installing the FalconDeck daemon…"
        case "starting": "Starting the daemon service…"
        case "pairing": "Requesting a secure pairing code…"
        case "done": "Connecting through the relay…"
        default: value.capitalized
        }
    }
}

@MainActor private func remoteCopy(_ value: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(value, forType: .string)
}

private func remoteDate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value)
}

private func remoteDisplayDate(_ value: String) -> String {
    remoteDate(value)?.formatted(date: .abbreviated, time: .shortened) ?? "Not yet"
}

private func remoteLabel(_ value: String) -> String {
    value.isEmpty ? "Not connected" : value.replacingOccurrences(of: "_", with: " ").capitalized
}

private func remoteQR(_ value: String) -> NSImage? {
    guard !value.isEmpty else { return nil }
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(value.utf8); filter.correctionLevel = "M"
    guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 6, y: 6)),
          let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
    return NSImage(cgImage: cg, size: NSSize(width: output.extent.width, height: output.extent.height))
}
