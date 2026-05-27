import SwiftUI
import WebKit
import AppKit

// The Railway-hosted production URL. Update here and rebuild if you
// move the backend (e.g. once the custom domain DNS is fixed:
// "https://zoomchat.ryteproductions.com"). No other code references it.
let kAppURL = URL(string: "https://web-production-92d23.up.railway.app")!

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
        }
    }
}

// MARK: - App delegate

/// Thin client: no backend processes to manage. The .app is just a
/// branded WKWebView pointing at the Railway-hosted server.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}

// MARK: - Content

struct ContentView: View {
    var body: some View {
        WebView(url: kAppURL)
    }
}

// MARK: - WKWebView wrapper

struct WebView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        // Persistent data store so settings (in localStorage) survive
        // app restarts. Shared between the main window and any pop-out
        // presenter windows because they're both Recall-loaded from the
        // same origin.
        config.websiteDataStore = .default()

        let webView = WKWebView(frame: .zero, configuration: config)
        // Handle window.open() (used by the React UI's "Pop out display"
        // button) by creating a real native window via
        // PopOutWindowManager — borderless, auto-placed on the secondary
        // screen.
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
        // Reuse the configuration WebKit passed in so cookies/session
        // match the parent.
        let newWebView = WKWebView(frame: .zero, configuration: configuration)
        newWebView.uiDelegate = self // chained window.open from this window too
        newWebView.setValue(false, forKey: "drawsBackground")

        // Pop-outs from the React UI are always intended for the
        // presenter's confidence monitor — borderless, full screen, on
        // the secondary display.
        PopOutWindowManager.shared.hostPresenter(webView: newWebView)

        // Returning the new web view tells WebKit to load
        // navigationAction.request into it automatically.
        return newWebView
    }
}

// MARK: - Borderless presenter window

/// Borderless windows can't become key by default, which prevents key
/// events (like our ⎋ Esc-to-close handler) from reaching the window.
/// Subclassing flips both flags on.
final class BorderlessKeyWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

/// Hosts pop-out WKWebViews as borderless, full-screen windows on the
/// secondary display (or the only display if there's just one). Keeps
/// strong references so windows aren't deallocated as soon as the
/// WebKit callback returns.
final class PopOutWindowManager {
    static let shared = PopOutWindowManager()
    private var windows: [NSWindow] = []
    private var eventMonitors: [ObjectIdentifier: Any] = [:]

    func hostPresenter(webView: WKWebView) {
        // Pick the secondary screen if available, otherwise the only one.
        let screens = NSScreen.screens
        let targetScreen = (screens.count > 1) ? screens[1] : screens.first
        let frame = targetScreen?.frame ?? NSRect(x: 0, y: 0, width: 1280, height: 720)

        let window = BorderlessKeyWindow(
            contentRect: frame,
            styleMask: [.borderless, .resizable],
            backing: .buffered,
            defer: false,
            screen: targetScreen
        )
        window.contentView = webView
        window.title = "ZoomChat Display" // metadata for window manager / accessibility
        window.backgroundColor = .black
        window.isReleasedWhenClosed = false
        // Joins all spaces so the operator can switch desktops freely
        // without dragging the presenter window around.
        window.collectionBehavior = [.fullScreenPrimary, .canJoinAllSpaces]
        window.setFrame(frame, display: true)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // ⎋ Esc closes the presenter window. (Without a title bar,
        // there's no X button — Esc is the standard exit.)
        let monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak window] event in
            if event.window === window && event.keyCode == 53 /* Escape */ {
                window?.close()
                return nil // consume
            }
            return event
        }
        if let m = monitor {
            eventMonitors[ObjectIdentifier(window)] = m
        }

        windows.append(window)
        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: window,
            queue: .main
        ) { [weak self, weak window] _ in
            guard let self = self, let window = window else { return }
            let key = ObjectIdentifier(window)
            if let m = self.eventMonitors.removeValue(forKey: key) {
                NSEvent.removeMonitor(m)
            }
            self.windows.removeAll { $0 === window }
        }
    }
}
