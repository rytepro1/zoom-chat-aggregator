import SwiftUI
import WebKit
import AppKit

// MARK: - App entry

@main
struct ZoomChatApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup("Zoom Chat Aggregator") {
            ContentView()
                .frame(minWidth: 900, minHeight: 600)
        }
        .windowResizability(.contentSize)
        .commands {
            // Drop unused menu items that don't apply to a kiosk-style app.
            CommandGroup(replacing: .newItem) {}
            CommandGroup(replacing: .pasteboard) {}
        }
    }
}

// MARK: - App delegate (manages Node subprocess lifecycle)

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var serverProcess: Process?
    private let serverPort = 3001

    func applicationDidFinishLaunching(_ notification: Notification) {
        startServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }

    private func startServer() {
        guard let resourcePath = Bundle.main.resourcePath else {
            showFatal("Could not locate app resources.")
            return
        }

        let projectPath = "\(resourcePath)/project"
        let nodePath = "\(resourcePath)/node-runtime/node"
        let serverScript = "src/server/index.js"

        guard FileManager.default.isExecutableFile(atPath: nodePath) else {
            showFatal("Bundled Node runtime not found at \(nodePath).")
            return
        }

        guard FileManager.default.fileExists(atPath: "\(projectPath)/\(serverScript)") else {
            showFatal("Bundled server script not found at \(projectPath)/\(serverScript).")
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [serverScript]
        process.currentDirectoryURL = URL(fileURLWithPath: projectPath)

        var env = ProcessInfo.processInfo.environment
        env["NODE_ENV"] = "production"
        env["PORT"] = String(serverPort)
        process.environment = env

        // Pipe stdout + stderr to a log file for debugging.
        let logURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("zoomchat-server.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        if let logHandle = try? FileHandle(forWritingTo: logURL) {
            process.standardOutput = logHandle
            process.standardError = logHandle
        }

        do {
            try process.run()
            self.serverProcess = process
        } catch {
            showFatal("Failed to start server: \(error.localizedDescription)")
        }
    }

    private func stopServer() {
        if let process = serverProcess, process.isRunning {
            process.terminate()
            process.waitUntilExit()
        }
        // Belt-and-suspenders: kill anything still bound to our port.
        let cleanup = Process()
        cleanup.executableURL = URL(fileURLWithPath: "/bin/sh")
        cleanup.arguments = ["-c", "PIDS=$(lsof -i :\(serverPort) -t 2>/dev/null); [ -n \"$PIDS\" ] && kill $PIDS 2>/dev/null"]
        try? cleanup.run()
        cleanup.waitUntilExit()
    }

    private func showFatal(_ message: String) {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = "ZoomChat could not start"
            alert.informativeText = message
            alert.alertStyle = .critical
            alert.runModal()
            NSApp.terminate(nil)
        }
    }
}

// MARK: - Content (loading screen, then WebView)

struct ContentView: View {
    @State private var isReady = false
    @State private var spinnerTick = 0

    var body: some View {
        Group {
            if isReady {
                WebView(url: URL(string: "http://localhost:3001")!)
            } else {
                VStack(spacing: 16) {
                    ProgressView().scaleEffect(1.4)
                    Text("Starting ZoomChat" + String(repeating: ".", count: spinnerTick % 4))
                        .font(.headline)
                        .foregroundColor(.secondary)
                        .monospacedDigit()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(NSColor.windowBackgroundColor))
            }
        }
        .task { await waitForServer() }
    }

    private func waitForServer() async {
        let healthURL = URL(string: "http://localhost:3001/health")!
        for i in 0..<60 {
            await MainActor.run { spinnerTick = i }
            do {
                var request = URLRequest(url: healthURL)
                request.timeoutInterval = 1.0
                let (_, response) = try await URLSession.shared.data(for: request)
                if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                    await MainActor.run { isReady = true }
                    return
                }
            } catch {
                // Not ready yet — keep polling.
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
        // 60s elapsed without success.
        await MainActor.run {
            let alert = NSAlert()
            alert.messageText = "ZoomChat did not start within 60 seconds"
            alert.informativeText = "Check the log at /tmp/zoomchat-server.log for details."
            alert.alertStyle = .critical
            alert.runModal()
            NSApp.terminate(nil)
        }
    }
}

// MARK: - WKWebView wrapper

struct WebView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        // Persistent data store so settings (in localStorage) survive restarts.
        config.websiteDataStore = .default()

        let webView = WKWebView(frame: .zero, configuration: config)
        // Handle window.open() (used by the React UI's "Pop out display" button)
        // by creating a real native window via PopOutWindowManager.
        webView.uiDelegate = context.coordinator
        webView.load(URLRequest(url: url))
        webView.setValue(false, forKey: "drawsBackground")
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}

    func makeCoordinator() -> WebViewCoordinator { WebViewCoordinator() }
}

// MARK: - window.open handling

final class WebViewCoordinator: NSObject, WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        let width  = windowFeatures.width?.doubleValue  ?? 1280
        let height = windowFeatures.height?.doubleValue ?? 720

        // Reuse the configuration WebKit passed in so cookies/session match the parent.
        let newWebView = WKWebView(frame: .zero, configuration: configuration)
        newWebView.uiDelegate = self // allow chained window.open from this window too
        newWebView.setValue(false, forKey: "drawsBackground")

        PopOutWindowManager.shared.host(
            webView: newWebView,
            size: CGSize(width: width, height: height),
            title: "ZoomChat — Display"
        )

        // Returning the new web view tells WebKit to load
        // navigationAction.request into it automatically.
        return newWebView
    }
}

/// Hosts pop-out WKWebViews in native NSWindows. Keeps strong references
/// so windows aren't deallocated as soon as the WebKit callback returns.
final class PopOutWindowManager {
    static let shared = PopOutWindowManager()
    private var windows: [NSWindow] = []

    func host(webView: WKWebView, size: CGSize, title: String) {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.contentView = webView
        window.collectionBehavior.insert(.fullScreenPrimary) // green ⌃⌘F button
        window.isReleasedWhenClosed = false
        window.center()
        window.makeKeyAndOrderFront(nil)

        windows.append(window)
        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: window,
            queue: .main
        ) { [weak self, weak window] _ in
            guard let window = window else { return }
            self?.windows.removeAll { $0 === window }
        }
    }
}
