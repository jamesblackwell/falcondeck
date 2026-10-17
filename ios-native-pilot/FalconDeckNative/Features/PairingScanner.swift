import AVFoundation
import SwiftUI
import VisionKit

struct PairingScanner: View {
    @Environment(\.dismiss) private var dismiss
    var relay: String
    var scanned: (String) -> Void
    @State private var allowed = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Group {
                if allowed, DataScannerViewController.isSupported {
                    QRScannerController { payload in
                        do { _ = try PairingInput(text: payload, relay: relay); scanned(payload); dismiss() }
                        catch { self.error = "This isn't a valid signed FalconDeck pairing code." }
                    } failed: { error = $0 }
                    .overlay(alignment: .bottom) {
                        Text(error ?? "Point the camera at your computer's FalconDeck pairing code.").font(.subheadline).padding().background(.regularMaterial, in: .rect(cornerRadius: 16)).padding()
                    }.ignoresSafeArea(edges: .bottom)
                } else {
                    ContentUnavailableView("Camera scanner unavailable", systemImage: "qrcode.viewfinder", description: Text(error ?? "Checking camera access…"))
                }
            }.navigationTitle("Scan pairing code").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
                .task {
                    guard DataScannerViewController.isSupported else { error = "Paste the signed pairing link to connect on this device."; return }
                    allowed = await AVCaptureDevice.requestAccess(for: .video)
                    if !allowed { error = "Allow camera access in Settings, or paste the pairing link." }
                }
        }
    }
}

private struct QRScannerController: UIViewControllerRepresentable {
    var scanned: (String) -> Void
    var failed: (String) -> Void
    func makeUIViewController(context: Context) -> ScannerContainer { ScannerContainer(scanned: scanned, failed: failed) }
    func updateUIViewController(_ controller: ScannerContainer, context: Context) { }
    static func dismantleUIViewController(_ controller: ScannerContainer, coordinator: ()) { controller.scanner.stopScanning() }
}

private final class ScannerContainer: UIViewController, DataScannerViewControllerDelegate {
    let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isPinchToZoomEnabled: true, isGuidanceEnabled: true, isHighlightingEnabled: true)
    let scanned: (String) -> Void
    let failed: (String) -> Void
    private var previousPayload: String?
    init(scanned: @escaping (String) -> Void, failed: @escaping (String) -> Void) { self.scanned = scanned; self.failed = failed; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    override func viewDidLoad() {
        super.viewDidLoad(); scanner.delegate = self
        addChild(scanner); view.addSubview(scanner.view)
        scanner.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([scanner.view.leadingAnchor.constraint(equalTo: view.leadingAnchor), scanner.view.trailingAnchor.constraint(equalTo: view.trailingAnchor), scanner.view.topAnchor.constraint(equalTo: view.topAnchor), scanner.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)])
        scanner.didMove(toParent: self)
    }
    override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); do { try scanner.startScanning() } catch { failed(error.localizedDescription) } }
    override func viewDidDisappear(_ animated: Bool) { super.viewDidDisappear(animated); scanner.stopScanning() }
    func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) { inspect(addedItems) }
    func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) { inspect([item]) }
    func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) { failed(error.localizedDescription) }
    private func inspect(_ items: [RecognizedItem]) {
        for item in items {
            if case .barcode(let barcode) = item, let value = barcode.payloadStringValue, value != previousPayload { previousPayload = value; scanned(value); return }
        }
    }
}
