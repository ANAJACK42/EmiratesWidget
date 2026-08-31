//
//  EK050 Widget – natives macOS-Fenster
//
//  Zeigt die Flugansicht in einem rahmenlosen, immer sichtbaren Fenster.
//  Bewusst klein gehalten: AppKit + WKWebView, beides von Apple, kein
//  fremdes Binary. Gebaut wird lokal mit dem Swift-Compiler der
//  Xcode Command Line Tools (siehe macos/build-mac-app.sh).
//

import Cocoa
import WebKit

/// Adresse der Widget-Seite. Über die Umgebungsvariable EK050_URL
/// überschreibbar, etwa für eine lokale Kopie.
let widgetURL: URL = {
    let fallback = "https://anajack42.github.io/EmiratesWidget/"
    let raw = ProcessInfo.processInfo.environment["EK050_URL"] ?? fallback
    return URL(string: raw) ?? URL(string: fallback)!
}()

/// Unsichtbarer Streifen über der Kopfzeile der Seite: Der WKWebView nimmt
/// sonst jeden Klick entgegen, sodass sich das rahmenlose Fenster nicht
/// verschieben lässt. Hier durchgereicht an performDrag.
final class DragStrip: NSView {
    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }

    // Doppelklick auf die Kopfzeile: wie bei jedem Mac-Fenster zoomen
    override func mouseUp(with event: NSEvent) {
        if event.clickCount == 2 { window?.zoom(nil) }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        load()
    }

    // MARK: Fenster

    private func buildWindow() {
        let configuration = WKWebViewConfiguration()

        // Die Ampelknöpfe liegen über der Kopfzeile der Seite – etwas Platz schaffen.
        let css = ".titlebar { padding-left: 76px !important; }"
        let js = """
        var s = document.createElement('style');
        s.textContent = \(jsStringLiteral(css));
        document.head.appendChild(s);
        """
        configuration.userContentController.addUserScript(
            WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )

        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 520, height: 760),
                            configuration: configuration)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "EK050 · MUC → DXB"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 320, height: 280)
        window.level = .floating          // immer über normalen Fenstern
        window.contentView = webView
        window.isReleasedWhenClosed = false

        // Position und Größe merken
        window.setFrameAutosaveName("EK050WidgetWindow")
        if window.frame.origin == .zero { window.center() }

        // Ziehflaeche oben einhaengen: volle Breite bis auf die rechten
        // 130 Punkte, dort liegen die Knöpfe der Seite (Design, Aktualisieren).
        if let content = window.contentView {
            let stripHeight: CGFloat = 38
            let strip = DragStrip(frame: NSRect(x: 0,
                                                y: content.bounds.height - stripHeight,
                                                width: max(0, content.bounds.width - 130),
                                                height: stripHeight))
            strip.autoresizingMask = [.width, .minYMargin]
            content.addSubview(strip)
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func load() {
        webView.load(URLRequest(url: widgetURL, cachePolicy: .reloadRevalidatingCacheData))
    }

    /// Erzeugt ein sicheres JavaScript-String-Literal.
    private func jsStringLiteral(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "\\n")
        return "'\(escaped)'"
    }

    // MARK: Menü

    private func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Aktualisieren", action: #selector(reload), keyEquivalent: "r")
        let pin = NSMenuItem(title: "Immer im Vordergrund",
                             action: #selector(toggleFloating), keyEquivalent: "p")
        pin.state = .on
        appMenu.addItem(pin)
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "EK050 beenden", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        // Standard-Bearbeiten-Menü, damit Kopieren und Auswählen funktionieren
        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Bearbeiten")
        editMenu.addItem(withTitle: "Kopieren", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Alles auswählen", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        NSApp.mainMenu = mainMenu
    }

    @objc private func reload() {
        webView.reload()
    }

    @objc private func toggleFloating(_ sender: NSMenuItem) {
        let floating = window.level == .floating
        window.level = floating ? .normal : .floating
        sender.state = floating ? .off : .on
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showLoadError(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showLoadError(error)
    }

    private func showLoadError(_ error: Error) {
        let html = """
        <html><body style="margin:0;background:#020504;color:#00ff9c;
        font:13px ui-monospace,Menlo,monospace;display:flex;align-items:center;
        justify-content:center;height:100vh;text-align:center">
        <div><div style="font-size:15px;font-weight:700">SEITE NICHT ERREICHBAR</div>
        <div style="margin-top:10px;color:#ffb000">\(error.localizedDescription)</div>
        <div style="margin-top:10px;opacity:.7">Menü → Aktualisieren (⌘R)</div></div>
        </body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
