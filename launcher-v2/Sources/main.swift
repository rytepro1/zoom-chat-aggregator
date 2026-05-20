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
        webView.load(URLRequest(url: url))
        // Hide the rubber-band scroll on the document body (looks better in a window).
        webView.setValue(false, forKey: "drawsBackground")
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
