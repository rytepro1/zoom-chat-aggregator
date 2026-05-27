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
/// branded WKWebView pointing at the Railway-hosted server. We DO own
/// the session-lifecycle UX on quit, though — the operator gets a
/// dialog asking whether to end the current session or just close the
/// app and leave the session running in the background.
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Closing the main window just hides it (app stays in the Dock);
    /// ⌘-Q is what triggers the end-session dialog.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    /// Restore the main window when the user clicks the Dock icon
    /// after closing it. SwiftUI's WindowGroup handles re-showing for
    /// us as long as we return true here.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        return true
    }

    /// On ⌘-Q (or any other quit trigger), ask whether to end the
    /// current session or just close the app. End-session is an async
    /// HTTP POST, so we return .terminateLater and reply when the
    /// network call completes.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let alert = NSAlert()
        alert.messageText = "End the current session?"
        alert.informativeText = "Ending the session finalizes its chat log on the server. Keeping it running leaves the session active in the background — useful if another operator is still working with it or you'll be back soon."
        alert.alertStyle = .informational
        alert.addButton(withTitle: "End Session and Quit")    // .alertFirstButtonReturn
        alert.addButton(withTitle: "Keep Running and Quit")   // .alertSecondButtonReturn
        alert.addButton(withTitle: "Cancel")                  // .alertThirdButtonReturn

        let response = alert.runModal()
        switch response {
        case .alertFirstButtonReturn:
            endSessionThenQuit()
            return .terminateLater
        case .alertSecondButtonReturn:
            return .terminateNow
        default:
            return .terminateCancel
        }
    }

    private func endSessionThenQuit() {
        var request = URLRequest(url: kAppURL.appendingPathComponent("api/sessions/end"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        request.timeoutInterval = 5

        URLSession.shared.dataTask(with: request) { _, response, error in
            if let error = error {
                NSLog("[ZoomChat] end-session POST failed: \(error.localizedDescription)")
            } else if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                NSLog("[ZoomChat] end-session POST returned HTTP \(http.statusCode)")
            }
            // Reply regardless — we already asked the user, no point
            // blocking the quit if the network call failed.
            DispatchQueue.main.async {
                NSApp.reply(toApplicationShouldTerminate: true)
            }
        }.resume()
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
        // Use DraggableWebView (subclass with mouseDownCanMoveWindow
        // overridden to true) so the presenter window can be dragged by
        // clicking anywhere on the chat feed — borderless windows have
        // no native title-bar drag region, and the React UI here is
        // read-only so we don't lose interactivity by treating every
        // mouseDown as a potential window-drag.
        let newWebView = DraggableWebView(frame: .zero, configuration: configuration)
        newWebView.uiDelegate = self // chained window.open from this window too
        newWebView.setValue(false, forKey: "drawsBackground")

        PopOutWindowManager.shared.hostPresenter(webView: newWebView)

        // Returning the new web view tells WebKit to load
        // navigationAction.request into it automatically.
        return newWebView
    }
}

/// WKWebView for the presenter pop-out:
///   - Click-and-drag moves the window (mouseDownCanMoveWindow = true).
///     AppKit distinguishes click from drag, so JS click events still
///     fire normally.
///   - Double-click toggles macOS native full-screen on the window the
///     view is hosted in. Lets the operator drag the window onto the
///     secondary display, double-click, and immediately get the
///     animated zoom-to-fill-screen presenter experience.
final class DraggableWebView: WKWebView {
    override var mouseDownCanMoveWindow: Bool { true }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            window?.toggleFullScreen(nil)
            return
        }
        super.mouseDown(with: event)
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
        // Placement rules:
        //  - Multi-monitor (production setup): fill the secondary
        //    screen's visibleFrame (excludes menu bar / Dock so the
        //    transparent-titlebar drag handle stays reachable).
        //  - Single monitor (laptop / testing): open at a comfortable
        //    centered 1280x720 window so the operator can drag /
        //    resize / move it once a second display is connected.
        let screens = NSScreen.screens
        let hasSecondary = screens.count > 1
        let targetScreen = hasSecondary ? screens[1] : screens.first

        let frame: NSRect
        if hasSecondary, let s = targetScreen {
            frame = s.visibleFrame
        } else if let p = screens.first {
            let w: CGFloat = min(1280, p.visibleFrame.width - 100)
            let h: CGFloat = min(720, p.visibleFrame.height - 100)
            frame = NSRect(
                x: p.visibleFrame.midX - w / 2,
                y: p.visibleFrame.midY - h / 2,
                width: w,
                height: h
            )
        } else {
            frame = NSRect(x: 0, y: 0, width: 1280, height: 720)
        }

        // Why titled + transparent titlebar instead of .borderless:
        // pure borderless windows have no drag region, and WKWebView
        // captures every mouse event so .isMovableByWindowBackground
        // doesn't fire either. A titled window with a hidden, transparent
        // titlebar gives us a real OS-managed drag region in the top
        // ~22px while looking visually borderless. .fullSizeContentView
        // lets the WKWebView extend underneath the titlebar so no
        // screen real estate is lost.
        let window = BorderlessKeyWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false,
            screen: targetScreen
        )
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        // Hide all three traffic light buttons so the window looks
        // genuinely borderless. Esc closes; Window menu re-fronts.
        window.standardWindowButton(.closeButton)?.isHidden = true
        window.standardWindowButton(.miniaturizeButton)?.isHidden = true
        window.standardWindowButton(.zoomButton)?.isHidden = true

        window.contentView = webView
        window.title = "ZoomChat Display" // metadata for window manager / accessibility
        window.backgroundColor = .black
        window.isReleasedWhenClosed = false
        // Belt-and-suspenders: also enable background drag in case
        // future React UI changes leave a non-interactive region the OS
        // might pick up.
        window.isMovableByWindowBackground = true
        // Joins all spaces so the operator can switch desktops freely
        // without dragging the presenter window around.
        window.collectionBehavior = [.fullScreenPrimary, .canJoinAllSpaces]
        window.setFrame(frame, display: true)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // Register with the app-wide Window menu so the operator can
        // bring it back to the front if it gets occluded behind the
        // main window. Manually-created NSWindows aren't added here
        // automatically the way SwiftUI WindowGroups are.
        NSApp.addWindowsItem(window, title: "ZoomChat Display", filename: false)

        // ⎋ Esc: if in full-screen, exit full-screen first (standard
        // browser/video-player behavior). Only close the window when
        // not in full-screen — otherwise the operator pressing Esc to
        // leave full-screen would accidentally nuke the window.
        let monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak window] event in
            if event.window === window && event.keyCode == 53 /* Escape */ {
                if let w = window, w.styleMask.contains(.fullScreen) {
                    w.toggleFullScreen(nil)
                } else {
                    window?.close()
                }
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
            NSApp.removeWindowsItem(window)
            self.windows.removeAll { $0 === window }
        }
    }
}
