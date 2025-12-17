import Foundation
import Capacitor
import WebKit

@objc(DAppBrowserPlugin)
public class DAppBrowserPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DAppBrowserPlugin"
    public let jsName = "DAppBrowserPlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)
    ]

    @objc func open(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url") else {
            call.reject("URL is required")
            return
        }

        guard let url = URL(string: urlString) else {
            call.reject("Invalid URL")
            return
        }

        let title = call.getString("title") ?? "Browser"
        let toolbarColor = call.getString("toolbarColor") ?? "#000000"
        let walletAddress = call.getString("walletAddress") ?? ""
        let chainId = call.getString("chainId") ?? "0x1"

        DispatchQueue.main.async {
            let browserVC = DAppBrowserViewController()
            browserVC.url = url
            browserVC.browserTitle = title
            browserVC.toolbarColorHex = toolbarColor
            browserVC.walletAddress = walletAddress
            browserVC.chainId = chainId
            browserVC.modalPresentationStyle = .fullScreen

            self.bridge?.viewController?.present(browserVC, animated: true) {
                call.resolve(["success": true])
            }
        }
    }
}

class DAppBrowserViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    var url: URL!
    var browserTitle: String = "Browser"
    var toolbarColorHex: String = "#000000"
    var walletAddress: String = ""
    var chainId: String = "0x1"

    private var webView: WKWebView!
    private var toolbar: UIView!
    private var titleLabel: UILabel!
    private var urlLabel: UILabel!
    private var backButton: UIButton!
    private var forwardButton: UIButton!
    private var refreshButton: UIButton!
    private var closeButton: UIButton!
    private var progressView: UIProgressView!

    override func viewDidLoad() {
        super.viewDidLoad()
        setupUI()
        loadURL()
    }

    private func setupUI() {
        view.backgroundColor = hexColor(toolbarColorHex)

        // Toolbar
        toolbar = UIView()
        toolbar.backgroundColor = hexColor(toolbarColorHex)
        toolbar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(toolbar)

        // Close button
        closeButton = UIButton(type: .system)
        closeButton.setImage(UIImage(systemName: "xmark"), for: .normal)
        closeButton.tintColor = .white
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        toolbar.addSubview(closeButton)

        // Title label
        titleLabel = UILabel()
        titleLabel.text = browserTitle
        titleLabel.textColor = .white
        titleLabel.font = UIFont.systemFont(ofSize: 17, weight: .semibold)
        titleLabel.textAlignment = .center
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        toolbar.addSubview(titleLabel)

        // Navigation bar
        let navBar = UIView()
        navBar.backgroundColor = hexColor(toolbarColorHex).withAlphaComponent(0.9)
        navBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(navBar)

        // Back button
        backButton = UIButton(type: .system)
        backButton.setImage(UIImage(systemName: "chevron.left"), for: .normal)
        backButton.tintColor = .white
        backButton.addTarget(self, action: #selector(backTapped), for: .touchUpInside)
        backButton.isEnabled = false
        backButton.translatesAutoresizingMaskIntoConstraints = false
        navBar.addSubview(backButton)

        // Forward button
        forwardButton = UIButton(type: .system)
        forwardButton.setImage(UIImage(systemName: "chevron.right"), for: .normal)
        forwardButton.tintColor = .white
        forwardButton.addTarget(self, action: #selector(forwardTapped), for: .touchUpInside)
        forwardButton.isEnabled = false
        forwardButton.translatesAutoresizingMaskIntoConstraints = false
        navBar.addSubview(forwardButton)

        // Refresh button
        refreshButton = UIButton(type: .system)
        refreshButton.setImage(UIImage(systemName: "arrow.clockwise"), for: .normal)
        refreshButton.tintColor = .white
        refreshButton.addTarget(self, action: #selector(refreshTapped), for: .touchUpInside)
        refreshButton.translatesAutoresizingMaskIntoConstraints = false
        navBar.addSubview(refreshButton)

        // URL label
        urlLabel = UILabel()
        urlLabel.text = url.host ?? ""
        urlLabel.textColor = .lightGray
        urlLabel.font = UIFont.systemFont(ofSize: 14)
        urlLabel.textAlignment = .center
        urlLabel.translatesAutoresizingMaskIntoConstraints = false
        navBar.addSubview(urlLabel)

        // Progress view
        progressView = UIProgressView(progressViewStyle: .bar)
        progressView.progressTintColor = UIColor(red: 0.84, green: 0.96, blue: 0.31, alpha: 1.0) // Accent color
        progressView.trackTintColor = .clear
        progressView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(progressView)

        // WebView configuration
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        // Preferences for better dApp support
        let preferences = WKWebpagePreferences()
        preferences.allowsContentJavaScript = true
        config.defaultWebpagePreferences = preferences

        // Allow local storage and cookies
        config.websiteDataStore = WKWebsiteDataStore.default()

        // Process pool for session sharing
        config.processPool = WKProcessPool()

        // CRITICAL: Inject Ethereum provider at document start (before any page JS runs)
        let contentController = WKUserContentController()

        if !walletAddress.isEmpty {
            let providerScript = generateEthereumProviderScript(address: walletAddress, chainId: chainId)
            let userScript = WKUserScript(
                source: providerScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: false
            )
            contentController.addUserScript(userScript)
        }

        config.userContentController = contentController

        // WebView
        webView = WKWebView(frame: .zero, configuration: config)
        webView.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)

        // Add KVO for progress
        webView.addObserver(self, forKeyPath: "estimatedProgress", options: .new, context: nil)

        // Layout
        NSLayoutConstraint.activate([
            // Toolbar
            toolbar.topAnchor.constraint(equalTo: view.topAnchor),
            toolbar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            toolbar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            toolbar.heightAnchor.constraint(equalToConstant: 100),

            // Close button
            closeButton.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor, constant: 16),
            closeButton.bottomAnchor.constraint(equalTo: toolbar.bottomAnchor, constant: -12),
            closeButton.widthAnchor.constraint(equalToConstant: 44),
            closeButton.heightAnchor.constraint(equalToConstant: 44),

            // Title
            titleLabel.centerXAnchor.constraint(equalTo: toolbar.centerXAnchor),
            titleLabel.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),

            // Nav bar
            navBar.topAnchor.constraint(equalTo: toolbar.bottomAnchor),
            navBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            navBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            navBar.heightAnchor.constraint(equalToConstant: 50),

            // Back button
            backButton.leadingAnchor.constraint(equalTo: navBar.leadingAnchor, constant: 16),
            backButton.centerYAnchor.constraint(equalTo: navBar.centerYAnchor),
            backButton.widthAnchor.constraint(equalToConstant: 44),
            backButton.heightAnchor.constraint(equalToConstant: 44),

            // Forward button
            forwardButton.leadingAnchor.constraint(equalTo: backButton.trailingAnchor, constant: 8),
            forwardButton.centerYAnchor.constraint(equalTo: navBar.centerYAnchor),
            forwardButton.widthAnchor.constraint(equalToConstant: 44),
            forwardButton.heightAnchor.constraint(equalToConstant: 44),

            // Refresh button
            refreshButton.leadingAnchor.constraint(equalTo: forwardButton.trailingAnchor, constant: 8),
            refreshButton.centerYAnchor.constraint(equalTo: navBar.centerYAnchor),
            refreshButton.widthAnchor.constraint(equalToConstant: 44),
            refreshButton.heightAnchor.constraint(equalToConstant: 44),

            // URL label
            urlLabel.leadingAnchor.constraint(equalTo: refreshButton.trailingAnchor, constant: 8),
            urlLabel.trailingAnchor.constraint(equalTo: navBar.trailingAnchor, constant: -16),
            urlLabel.centerYAnchor.constraint(equalTo: navBar.centerYAnchor),

            // Progress view
            progressView.topAnchor.constraint(equalTo: navBar.bottomAnchor),
            progressView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            progressView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            progressView.heightAnchor.constraint(equalToConstant: 2),

            // WebView
            webView.topAnchor.constraint(equalTo: progressView.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    private func loadURL() {
        let request = URLRequest(url: url)
        webView.load(request)
    }

    @objc private func closeTapped() {
        dismiss(animated: true)
    }

    @objc private func backTapped() {
        webView.goBack()
    }

    @objc private func forwardTapped() {
        webView.goForward()
    }

    @objc private func refreshTapped() {
        webView.reload()
    }

    // MARK: - KVO
    override func observeValue(forKeyPath keyPath: String?, of object: Any?, change: [NSKeyValueChangeKey : Any]?, context: UnsafeMutableRawPointer?) {
        if keyPath == "estimatedProgress" {
            progressView.progress = Float(webView.estimatedProgress)
            progressView.isHidden = webView.estimatedProgress >= 1.0
        }
    }

    deinit {
        webView?.removeObserver(self, forKeyPath: "estimatedProgress")
    }

    // MARK: - WKNavigationDelegate
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        backButton.isEnabled = webView.canGoBack
        forwardButton.isEnabled = webView.canGoForward
        urlLabel.text = webView.url?.host ?? ""
        titleLabel.text = webView.title ?? browserTitle
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        progressView.isHidden = false
        progressView.progress = 0
    }

    // MARK: - WKNavigationDelegate - Policy decisions
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }

        let scheme = url.scheme?.lowercased() ?? ""

        // Allow http/https navigation within the webview
        if scheme == "http" || scheme == "https" {
            decisionHandler(.allow)
            return
        }

        // Handle special schemes (wallet links, deep links, etc.)
        if scheme == "wc" || scheme == "metamask" || scheme == "trust" || scheme == "rainbow" {
            // These are wallet connect or wallet deep links - ignore them
            decisionHandler(.cancel)
            return
        }

        // For other schemes (tel:, mailto:, etc.), open in system handler
        if UIApplication.shared.canOpenURL(url) {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
        decisionHandler(.cancel)
    }

    // MARK: - WKUIDelegate
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // Handle target="_blank" links - load them in the same webview instead of opening externally
        if navigationAction.targetFrame == nil || navigationAction.targetFrame?.isMainFrame == false {
            webView.load(navigationAction.request)
        }
        return nil
    }

    // Handle JavaScript alerts
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
            completionHandler()
        })
        present(alert, animated: true)
    }

    // Handle JavaScript confirms
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in
            completionHandler(false)
        })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
            completionHandler(true)
        })
        present(alert, animated: true)
    }

    // Handle JavaScript prompts
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { textField in
            textField.text = defaultText
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in
            completionHandler(nil)
        })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
            completionHandler(alert.textFields?.first?.text)
        })
        present(alert, animated: true)
    }

    // MARK: - Ethereum Provider Script
    private func generateEthereumProviderScript(address: String, chainId: String) -> String {
        return """
        (function() {
            if (window.ethereum) return;

            const accounts = ['\(address)'];
            const chainId = '\(chainId)';
            const listeners = {};

            const provider = {
                isMetaMask: true,
                isPunkWallet: true,
                chainId: chainId,
                networkVersion: String(parseInt(chainId, 16)),
                selectedAddress: accounts[0],
                isConnected: () => true,

                request: async function({ method, params }) {
                    console.log('[PunkWallet] request:', method);
                    switch (method) {
                        case 'eth_requestAccounts':
                        case 'eth_accounts':
                            return accounts;
                        case 'eth_chainId':
                            return chainId;
                        case 'net_version':
                            return String(parseInt(chainId, 16));
                        case 'wallet_switchEthereumChain':
                            return null;
                        case 'eth_getBalance':
                            return '0x0';
                        default:
                            console.log('[PunkWallet] Unsupported method:', method);
                            throw { code: 4200, message: 'Method not supported: ' + method };
                    }
                },

                on: function(event, cb) {
                    if (!listeners[event]) listeners[event] = [];
                    listeners[event].push(cb);
                    return this;
                },

                removeListener: function(event, cb) {
                    if (listeners[event]) {
                        listeners[event] = listeners[event].filter(l => l !== cb);
                    }
                    return this;
                },

                emit: function(event, data) {
                    if (listeners[event]) listeners[event].forEach(cb => cb(data));
                },

                enable: async function() {
                    return this.request({ method: 'eth_requestAccounts' });
                },

                send: function(method, params) {
                    if (typeof method === 'string') {
                        return this.request({ method, params });
                    }
                    return this.request(method);
                },

                sendAsync: function(payload, cb) {
                    this.request(payload)
                        .then(r => cb(null, { id: payload.id, jsonrpc: '2.0', result: r }))
                        .catch(e => cb(e));
                }
            };

            Object.defineProperty(window, 'ethereum', {
                value: provider,
                writable: false,
                configurable: false
            });

            // EIP-6963 announcement for modern dApps
            const info = {
                uuid: 'punk-wallet-ios',
                name: 'Punk Wallet',
                icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23d6f550" width="100" height="100" rx="20"/><text x="50" y="70" font-size="60" text-anchor="middle" fill="%23000">P</text></svg>',
                rdns: 'app.punkwallet'
            };

            function announce() {
                window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
                    detail: Object.freeze({ info: Object.freeze(info), provider })
                }));
            }

            window.addEventListener('eip6963:requestProvider', announce);
            announce();

            setTimeout(() => provider.emit('connect', { chainId }), 1);

            console.log('[PunkWallet] Provider injected:', accounts[0], chainId);
        })();
        """
    }

    // MARK: - Helper
    private func hexColor(_ hex: String) -> UIColor {
        var hexSanitized = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        hexSanitized = hexSanitized.replacingOccurrences(of: "#", with: "")

        var rgb: UInt64 = 0
        Scanner(string: hexSanitized).scanHexInt64(&rgb)

        return UIColor(
            red: CGFloat((rgb & 0xFF0000) >> 16) / 255.0,
            green: CGFloat((rgb & 0x00FF00) >> 8) / 255.0,
            blue: CGFloat(rgb & 0x0000FF) / 255.0,
            alpha: 1.0
        )
    }
}
