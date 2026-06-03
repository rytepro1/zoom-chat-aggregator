# macOS launcher (Swift WKWebView)

> Thin-client `.app` that wraps the Railway-hosted React UI in a native macOS window; targets macOS 13+ (universal arm64 + x86_64, ad-hoc signed, no notarization).

---

## How we use it

All source lives in a single file: `launcher-v2/Sources/main.swift`. The `build.sh` script in the same directory compiles it, assembles a `.app` bundle, and ad-hoc codesigns it. There is no Xcode project, no `Package.swift`, and no SPM dependencies — just two `swiftc` invocations lipo'd together.

### Entry point and window lifecycle

The `@main` struct `ZoomChatApp` (`main.swift:13`) is a SwiftUI `App`. It uses `Window("Zoom Chat Aggregator", id: "main")` (`main.swift:22`) instead of `WindowGroup` deliberately: `WindowGroup` leaves nothing to reopen when the last window closes, so clicking the Dock icon did nothing. `Window` (introduced macOS 13 / WWDC22) enforces a single-instance window: closing hides it; clicking the Dock icon brings it back. `AppDelegate.applicationShouldHandleReopen` (`main.swift:66`) returns `true` to support that re-show.

`AppDelegate.applicationShouldTerminateAfterLastWindowClosed` (`main.swift:59`) returns `false` so closing the window does not quit the app.

### Production URL

`kAppURL` is a module-level constant pointing at the Railway-hosted backend (`main.swift:8`). There is no discovery, no config file, no environment variable — changing the target URL requires editing `main.swift` and rebuilding.

### Cmd-R reload

A `CommandGroup` in the SwiftUI scene (`main.swift:35–41`) adds a **Reload** menu item bound to ⌘R. It posts a `Notification.Name.reloadWebView` notification. The `WebViewCoordinator` observes that notification (`main.swift:173–182`) and loads the root URL with `.reloadIgnoringLocalAndRemoteCacheData` (`main.swift:197–199`), bypassing both local and proxy caches. Comment in code explains why this is used over `reloadFromOrigin()`: the latter revalidates cached subresources but may still serve a stale hashed JS bundle from a previous deploy; loading the raw URL with no-cache forces a fresh GET of the HTML which then references newly-hashed asset filenames.

### WKWebView configuration

`ContentView` wraps `WebView(url: kAppURL)` (`main.swift:121–122`). `WebView` is an `NSViewRepresentable` (`main.swift:127`). In `makeNSView`:

- `config.defaultWebpagePreferences.allowsContentJavaScript = true` (`main.swift:132`) — JS is explicitly on (it is the default, but this makes intent clear).
- `config.websiteDataStore = .default()` (`main.swift:137`) — persistent data store; `localStorage` and cookies survive app restarts. Shared across all `WKWebView` instances created from the same process because `.default()` is process-global.
- `webView.uiDelegate = context.coordinator` (`main.swift:144`) — routes `window.open()` and JS dialogs to the coordinator.
- `webView.navigationDelegate = context.coordinator` (`main.swift:149`) — routes download-policy decisions and content-process crash notifications to the coordinator.
- `webView.setValue(false, forKey: "drawsBackground")` (`main.swift:151`) — **private KVC API**, suppresses the white background flash during load. See Risks section.

The coordinator's `webView` property is held `weak` (`main.swift:169`) to avoid a retain cycle (SwiftUI owns the `WKWebView` lifetime; the coordinator must not pin it).

### JS dialog delegation (WKUIDelegate)

Without these handlers `window.alert()` resolves silently, `window.confirm()` returns `undefined` (falsy), and `window.prompt()` returns `null`. The coordinator implements all three (`main.swift:238–290`):

- `runJavaScriptAlertPanelWithMessage` → `NSAlert` with OK button; calls `completionHandler()`.
- `runJavaScriptConfirmPanelWithMessage` → `NSAlert` with OK/Cancel; passes `response == .alertFirstButtonReturn` to the handler.
- `runJavaScriptTextInputPanelWithPrompt` → `NSAlert` with an `NSTextField` accessory; passes the string or `nil` on cancel.

### Download handling (WKNavigationDelegate + WKDownloadDelegate)

The React UI has a "PNG export" feature that fires an `<a download>` click. Without a `navigationDelegate`, WKWebView silently swallows the click. The coordinator implements two policy methods:

1. `decidePolicyFor navigationAction` (`main.swift:299–309`) — if `navigationAction.shouldPerformDownload` is true (set by WebKit when the anchor has a `download` attribute), returns `.download` instead of `.allow`.
2. `decidePolicyFor navigationResponse` (`main.swift:313–325`) — catches server-initiated downloads declared via `Content-Disposition: attachment`.

Both `navigationAction didBecome download` and `navigationResponse didBecome download` callbacks (`main.swift:331–337`) set `download.delegate = self` so the coordinator can pick the destination. If the delegate is not set, WebKit automatically cancels the download.

`download(_:decideDestinationUsing:suggestedFilename:completionHandler:)` (`main.swift:344–364`) auto-saves to `~/Downloads`. If a file with the same name exists it appends an ISO 8601 timestamp (colons replaced with dashes). No save panel — the design favors speed over user choice.

### window.open() and the presenter pop-out

`webView(_:createWebViewWith:for:windowFeatures:)` (`main.swift:205–227`) intercepts `window.open()` calls from the React UI's "Pop out display" button. It creates a `DraggableWebView` (a `WKWebView` subclass, `main.swift:383`) and hands it to `PopOutWindowManager.shared.hostPresenter(webView:)` (`main.swift:414`).

`PopOutWindowManager` (`main.swift:409–519`) creates a `BorderlessKeyWindow` (an `NSWindow` subclass where `canBecomeKey` and `canBecomeMain` return `true`, `main.swift:400–403`). The window style is `.titled | .closable | .miniaturizable | .resizable | .fullSizeContentView` with `titlebarAppearsTransparent = true` and `titleVisibility = .hidden`. All three traffic-light buttons are hidden (`main.swift:461–463`). This achieves the look of a borderless window while keeping AppKit's title-bar drag region (pure `.borderless` windows cannot be dragged when WKWebView fills the content view).

Placement logic (`main.swift:418–440`):
- Multi-monitor: fills `screens[1].visibleFrame` (excludes menu bar / Dock).
- Single monitor: opens a centered 1280×720 window.

`DraggableWebView.mouseDownCanMoveWindow` returns `true` (`main.swift:384`) so click-and-drag moves the window anywhere. Double-click toggles native full-screen via `window?.toggleFullScreen(nil)` (`main.swift:388`).

The window has `.collectionBehavior = [.fullScreenPrimary, .canJoinAllSpaces]` (`main.swift:475`) so it can enter full-screen natively and follows the user across Spaces.

ESC handling: a local event monitor (`main.swift:490–499`) is registered for `.keyDown` on the presenter window. ESC exits full-screen if the window is full-screen; otherwise closes the window. The monitor is removed on `NSWindow.willCloseNotification` (`main.swift:506–518`).

Strong references to both the `NSWindow` and its event monitor are kept in `PopOutWindowManager.windows` and `PopOutWindowManager.eventMonitors` arrays (`main.swift:410–411`) to prevent deallocation.

### Quit / session teardown

`AppDelegate.applicationShouldTerminate` (`main.swift:74–93`) intercepts ⌘Q (and all other quit triggers). It presents a three-button `NSAlert`:

- **End Session and Quit** — calls `endSessionThenQuit()`, returns `.terminateLater`.
- **Keep Running and Quit** — returns `.terminateNow`.
- **Cancel** — returns `.terminateCancel`.

`endSessionThenQuit()` (`main.swift:95–114`) fires a `POST /api/sessions/end` to `kAppURL` with a 5-second timeout. On completion (success or failure) it calls `NSApp.reply(toApplicationShouldTerminate: true)` on the main queue. The app always quits after the network call finishes — the comment explicitly notes this is intentional ("we already asked the user, no point blocking the quit").

### Build and packaging

`build.sh` compiles the single Swift file twice (`-target arm64-apple-macos13` and `-target x86_64-apple-macos13`) and `lipo`s a universal binary (`build.sh:22–31`). It assembles a minimal `.app` bundle with a hand-written `Info.plist` (`build.sh:39–67`), generates `.icns` from `icon-source.png` via `sips` + `iconutil` (`build.sh:70–84`), and ad-hoc codesigns with `codesign --force --deep --sign -` (`build.sh:88–89`). Output is `~/Applications/ZoomChat.app` (~5 MB). No Xcode, no SPM, no bundled frameworks.

---

## Core concepts

**WKWebView** is a multi-process web rendering engine embedded in an app. The UI process (your Swift code) communicates with a WebContent process over XPC. Each `WKWebView` instance is backed by a WebContent process (though multiple views may share one depending on configuration). If the WebContent process crashes, the view goes blank and `webViewWebContentProcessDidTerminate(_:)` fires.

**WKWebViewConfiguration** is a one-shot config object — it must be fully configured before passing to `WKWebView(frame:configuration:)`. Properties mutated after init have no effect.

**WKWebsiteDataStore** manages cookies, IndexedDB, localStorage, caches, and credentials for a web view. `.default()` is persistent and process-global. Two `WKWebView` instances using `.default()` share the same credential and cookie store. `.nonPersistent()` creates an ephemeral in-memory store.

**NSViewRepresentable / Coordinator** pattern: `makeCoordinator()` is called once before `makeNSView`. SwiftUI holds a strong reference to the coordinator for the representable's lifetime. The coordinator should hold the `WKWebView` weakly (`weak var webView`) to prevent a retain cycle (view → delegate → view).

**WKUIDelegate** must be assigned or JS dialogs silently no-op. There is no fallback behavior — no error, no throw; the page just hangs waiting for the completion handler forever if you don't call it.

**WKDownloadDelegate** must be assigned to an in-flight `WKDownload` or WebKit cancels it immediately. The `decideDestinationUsing:completionHandler:` callback must call `completionHandler` with a valid URL (or `nil` to cancel). Passing `nil` cancels cleanly.

**Ad-hoc codesign** (`codesign --sign -`) satisfies the requirement that code is signed but does not chain to a Developer ID certificate. Gatekeeper treats the app as "unidentified developer" — the first launch requires right-click → Open (or System Settings → Privacy & Security → Open Anyway). If the `.app` is downloaded and has a quarantine xattr, the user must explicitly approve it once. Apps distributed over a network share or AirDrop typically acquire the xattr.

**isInspectable** (macOS 13.3+): WKWebView defaults to non-inspectable in release builds. Setting `webView.isInspectable = true` opts in to Safari Web Inspector debugging.

---

## API / SDK surface we touch

| Symbol | Type | Purpose in our code | Notes |
|---|---|---|---|
| `WKWebView(frame:configuration:)` | Initializer | Creates the main and pop-out web views | Configuration must be fully set before this call |
| `WKWebViewConfiguration` | Class | JS enabled, persistent data store | Configured in `makeNSView` (`main.swift:131–138`) |
| `WKWebViewConfiguration.defaultWebpagePreferences.allowsContentJavaScript` | Property | Explicitly enables JS | Default is true; explicit for clarity |
| `WKWebViewConfiguration.websiteDataStore` | Property | Persistent storage (localStorage, cookies) | Set to `.default()` (`main.swift:137`) |
| `WKWebView.uiDelegate` | Delegate property | Routes JS dialogs and window.open() | Assigned to `WebViewCoordinator` |
| `WKWebView.navigationDelegate` | Delegate property | Routes download policy + process crash | Assigned to `WebViewCoordinator` |
| `WKWebView.load(_:)` | Method | Initial page load and ⌘R reload | Called with no-cache `URLRequest` on reload |
| `WKWebView.reloadFromOrigin()` | Method | Fallback reload path (url is nil) | Cache-revalidates; may serve stale subresources — see `main.swift:192` |
| `WKWebView.setValue(false, forKey: "drawsBackground")` | **Private KVC** | Removes white background flash | Not public API; can throw `NSUnknownKeyException` |
| `WKUIDelegate.webView(_:createWebViewWith:for:windowFeatures:)` | Delegate | Handles `window.open()` | Returns new `DraggableWebView`; WebKit loads the navigation into it |
| `WKUIDelegate.runJavaScriptAlertPanelWithMessage` | Delegate | JS `alert()` → native NSAlert | Must call `completionHandler()` or page hangs |
| `WKUIDelegate.runJavaScriptConfirmPanelWithMessage` | Delegate | JS `confirm()` → native NSAlert | Must call `completionHandler(Bool)` |
| `WKUIDelegate.runJavaScriptTextInputPanelWithPrompt` | Delegate | JS `prompt()` → native NSTextField alert | Must call `completionHandler(String?)` |
| `WKNavigationDelegate.decidePolicyFor navigationAction` | Delegate | Intercept `<a download>` clicks | Returns `.download` when `shouldPerformDownload` |
| `WKNavigationDelegate.decidePolicyFor navigationResponse` | Delegate | Intercept `Content-Disposition: attachment` | Returns `.download` |
| `WKNavigationDelegate.navigationAction didBecome download` | Delegate | Claim the `WKDownload` object | Sets `download.delegate = self` |
| `WKNavigationDelegate.navigationResponse didBecome download` | Delegate | Claim the `WKDownload` object | Sets `download.delegate = self` |
| `WKDownloadDelegate.download(_:decideDestinationUsing:suggestedFilename:completionHandler:)` | Delegate | Pick save path in ~/Downloads | Timestamp-suffixes on collision |
| `WKDownloadDelegate.downloadDidFinish` | Delegate | Log completion | NSLog only, no UI feedback |
| `WKDownloadDelegate.download(_:didFailWithError:resumeData:)` | Delegate | Log failure | No retry; resumeData ignored |
| `WKNavigationAction.shouldPerformDownload` | Property | True when anchor has `download` attribute | Available macOS 11.3+ |
| `NSApp.reply(toApplicationShouldTerminate:)` | Method | Async quit confirmation after network call | Called on main queue in `endSessionThenQuit` |
| `NSEvent.addLocalMonitorForEvents(matching:handler:)` | Function | ESC key handler for presenter window | Monitor stored and removed on window close |
| `NSWindow.CollectionBehavior.fullScreenPrimary` | Option | Presenter window can go full-screen | Combined with `.canJoinAllSpaces` |
| `NSWindow.CollectionBehavior.canJoinAllSpaces` | Option | Presenter window visible on all Spaces | |
| `DraggableWebView.mouseDownCanMoveWindow` | Override | Drag presenter window by clicking anywhere | `WKWebView` subclass |

**Not used (available but not wired):**
- `WKWebView.isInspectable` — production inspector not enabled; see Risks.
- `WKWebView.themeColor` — theme color meta-tag reading (macOS 12+).
- `WKWebView.underPageBackgroundColor` — public API for background color (macOS 12+, would replace the private KVC call).
- `WKWebViewConfiguration.userContentController` — no JS message handlers or injected scripts.
- `WKNavigationDelegate.webViewWebContentProcessDidTerminate(_:)` — WebContent process crash not handled; see Risks.
- `WKDownloadDelegate.download(_:didReceive:completionHandler:)` — auth challenges during downloads not handled.

---

## Auth & secrets

There are no secrets in the launcher. Authentication is handled entirely by the server-side React app loaded in the `WKWebView`. Credentials live in the browser's session via the persistent `WKWebsiteDataStore.default()`, meaning login cookies and localStorage tokens survive app restarts.

The only hardcoded credential-adjacent value is `kAppURL` (`main.swift:8`) — the Railway production URL. This is not a secret but is a deployment-specific constant that must be edited and the app rebuilt if the URL changes.

`endSessionThenQuit` sends a POST to `/api/sessions/end` with an empty JSON body and no auth headers (`main.swift:96–99`). The endpoint presumably relies on the session cookie that WKWebView includes automatically (via the shared data store). If the session has expired or the user is unauthenticated, the endpoint will return a 4xx, which the code logs and ignores.

---

## Webhooks / events

Not applicable. The launcher does not register any webhooks or subscribe to push events. All realtime data flows through the WebSocket connection maintained by the React app loaded inside WKWebView. The native layer's only outbound network call is the `POST /api/sessions/end` on quit.

---

## Version-specific notes

**macOS 13.0 minimum** (set in both `swiftc -target arm64-apple-macos13` and `Info.plist LSMinimumSystemVersion 13.0`):
- `Window` scene (single-instance) requires macOS 13.
- `WKDownload` / `WKDownloadDelegate` / `shouldPerformDownload` are available from macOS 11.3+, so no guard is needed.
- `WKWebView.isInspectable` requires macOS 13.3+; not currently set in code.

**macOS 14+ (Sonoma):** Gatekeeper behavior for ad-hoc signed apps tightened further. Apps without a quarantine xattr continue to launch without a warning. Apps downloaded over the network require the user to explicitly approve once. This is unchanged behavior from Ventura but Apple has indicated further tightening is possible.

**macOS 15 (Sequoia):** No WebKit breaking changes identified for our usage patterns. The "Open Anyway" button still appears in System Settings when an ad-hoc signed app is quarantined. The only permanent fix is Developer ID signing + notarization.

**WKDownload API** (introduced WWDC21, available macOS 11.3+): `download.delegate` **must** be set before returning from the `didBecome download` callback or the download is immediately cancelled. The `decideDestinationUsing:completionHandler:` method on `WKDownloadDelegate` also has an async Swift variant (`async -> URL?`) available as an alternative to the closure form used here.

**`-parse-as-library` compiler flag** (`build.sh:23,26`): Required when using `@main` in a single-file compile invocation (the file is named `main.swift`, which would normally receive special top-level-code treatment). The flag tells the compiler to parse the file as a module rather than as `main.swift`, allowing `@main` to work correctly.

---

## Rate limits / quotas / scaling

Not applicable to the native launcher itself. Network calls made by the launcher:

- `POST /api/sessions/end`: one call per app quit. 5-second `timeoutInterval` hardcoded (`main.swift:101`). No retry. Rate limiting is governed by the Railway backend, not the launcher.

All other network traffic originates from the WKWebView process (the React app) and is subject to the same limits as a browser hitting those endpoints.

---

## Gotchas & failure modes

**Web content process crash (blank screen).** If the WKWebView's WebContent process crashes (OOM or WebKit bug), the view renders blank and stays blank. `webViewWebContentProcessDidTerminate(_:)` is not implemented. The user must hit ⌘R to recover. A long-running kiosk app is particularly exposed: pages with heavy React rendering or a memory-hungry WebSocket can hit the WebContent process memory limit.

**`window.open()` creates a second WebContent process.** Each `DraggableWebView` instance spawned by `createWebViewWith:for:windowFeatures:` may run in its own WebContent process. If the presenter window is opened and closed repeatedly, each cycle allocates a new process. `PopOutWindowManager.windows` grows until closed windows are cleaned up by the `willCloseNotification` handler — that cleanup is correct, but WebKit may not immediately reclaim the WebContent process memory.

**`kAppURL` is a compile-time constant.** The Railway URL or future custom domain is hardcoded at `main.swift:8`. Changing the target (e.g., switching to `zoomchat.ryteproductions.com`) requires editing, rebuilding, and redistributing the `.app`. There is no runtime configuration mechanism.

**Ad-hoc signing + Gatekeeper.** First-launch approval is required on any Mac that downloaded the `.app`. The `codesign --force --deep --sign -` in `build.sh:89` is wrapped in `|| true`, so a codesigning failure is silently ignored and the binary ships unsigned, which is worse (presents a "damaged and cannot be opened" dialog with no override path). See Risks.

**`drawsBackground` private KVC.** Calling `webView.setValue(false, forKey: "drawsBackground")` will throw an `NSUnknownKeyException` if Apple removes this private property. The exception is uncaught and will crash the app on launch for all users. The public replacement (`underPageBackgroundColor`, macOS 12+) or setting `webView.isOpaque = false` with a clear background color is preferred.

**`endSessionThenQuit` POST has no auth header.** If the session cookie is not present in the WKWebView's data store (e.g., after a hard reset or data store clear), the POST will return 401/403. The code logs it and quits anyway (`main.swift:108–111`), so the session may remain active server-side after quit.

**No download auth-challenge handler.** `WKDownloadDelegate.download(_:didReceive:completionHandler:)` is not implemented. If the Railway backend returns a 401 during a download (e.g., token expiry mid-download), the download silently fails with `didFailWithError`.

**NSEvent monitor not removed on coordinator deinit.** The `WebViewCoordinator.deinit` (`main.swift:185`) removes the `NotificationCenter` observer for ⌘R, but the event monitors registered in `PopOutWindowManager` are tied to individual window close notifications — not to coordinator lifetime. This is correct for the presenter windows but means a logic error (e.g., failing to call `NSWindow.willCloseNotification` teardown) would leak a monitor indefinitely.

**`reloadFromOrigin()` fallback branch is dead code.** `url` is always non-nil because it is set in `makeNSView` (`main.swift:155`) before any reload can be triggered. The `else` branch at `main.swift:200–202` can never execute.

**Single-monitor presenter placement uses screen index `[1]`.** If the user has rearranged displays in System Preferences such that the "secondary" (non-main) screen is at index 0 and the main display is at index 1, the presenter window opens on the wrong screen. `NSScreen.screens` order is undefined and not guaranteed to put the non-main display at index 1.

---

## Risks / TODOs in our current code

| Severity | Location | Issue |
|---|---|---|
| High | `main.swift:151` | `setValue(false, forKey: "drawsBackground")` is a private KVC API. Can crash with `NSUnknownKeyException` on any WebKit update. Replace with `webView.underPageBackgroundColor = .clear` (macOS 12+) or `webView.isOpaque = false; webView.backgroundColor = .clear`. |
| High | `main.swift` (missing) | `webViewWebContentProcessDidTerminate(_:)` is not implemented. A WebContent crash leaves a permanent blank screen. Add `webView.reload()` or a full re-init inside this delegate method. |
| Medium | `build.sh:89` | `codesign ... || true` silently swallows signing failures. Remove `|| true`; let the build fail visibly so an unsigned binary is never distributed. |
| Medium | `main.swift:8` | `kAppURL` is hardcoded. The comment says to "update here and rebuild" for a custom domain — there is no CI or automated rebuild. Treat this as a manual step that is easy to forget. Consider a build-time variable or a JSON/plist sidecar loaded at runtime. |
| Medium | `main.swift:96–99` | `POST /api/sessions/end` sends no auth token. If the cookie is missing or expired, the session is not ended server-side. At minimum, log the HTTP status at a higher visibility level than `NSLog`. |
| Medium | `main.swift` (missing) | `WKWebView.isInspectable` is not set. Engineers cannot use Safari Web Inspector to debug the production app without adding this flag and rebuilding. Add `#if DEBUG` guard or a menu-accessible toggle. |
| Low | `main.swift:192–202` | `reloadFromOrigin()` fallback is dead code (`url` is always set). Remove the `else` branch. |
| Low | `main.swift:424` | `screens[1]` assumes the secondary display is always at index 1. Use `NSScreen.screens.first(where: { $0 != NSScreen.main })` for robustness. |
| Low | `main.swift` (missing) | Download failures (`didFailWithError`) are logged to `NSLog` only. No user-visible notification. Consider posting an `NSUserNotification` or showing a temporary banner. |
| Info | `build.sh` | No notarization step. App is ad-hoc signed only. Apple has stated notarization requirements may be extended to directly distributed apps in future macOS versions. |

---

## Key links

- [WKWebView — Apple Developer Documentation](https://developer.apple.com/documentation/webkit/wkwebview)
- [WKUIDelegate — Apple Developer Documentation](https://developer.apple.com/documentation/webkit/wkuidelegate)
- [WKNavigationDelegate — Apple Developer Documentation](https://developer.apple.com/documentation/webkit/wknavigationdelegate)
- [WKDownloadDelegate — Apple Developer Documentation](https://developer.apple.com/documentation/webkit/wkdownloaddelegate)
- [WKWebsiteDataStore — Apple Developer Documentation](https://developer.apple.com/documentation/webkit/wkwebsitedatastore)
- [Explore WKWebView additions — WWDC21](https://developer.apple.com/videos/play/wwdc2021/10032/) — download API introduction
- [What's new in WKWebView — WWDC22](https://developer.apple.com/videos/play/wwdc2022/10049/)
- [Enabling the Inspection of Web Content in Apps — WebKit Blog](https://webkit.org/blog/13936/enabling-the-inspection-of-web-content-in-apps/) — `isInspectable` deep dive
- [Bring multiple windows to your SwiftUI app — WWDC22](https://developer.apple.com/videos/play/wwdc2022/10061/) — `Window` vs `WindowGroup`
- [Tailor macOS windows with SwiftUI — WWDC24](https://developer.apple.com/videos/play/wwdc2024/10148/)
- [Graceful Application Termination — Apple Library](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/AppArchitecture/Tasks/GracefulAppTermination.html)
- [NSEvent.addLocalMonitorForEvents — Apple Developer Documentation](https://developer.apple.com/documentation/appkit/nsevent/1534971-addlocalmonitorforeventsmatching)
- [NSWindow.CollectionBehavior — Apple Developer Documentation](https://developer.apple.com/documentation/appkit/nswindow/collectionbehavior)
