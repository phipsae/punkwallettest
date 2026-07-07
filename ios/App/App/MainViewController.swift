import UIKit
import Capacitor

// Registers in-app Capacitor plugins. Referenced from Main.storyboard in
// place of the stock CAPBridgeViewController.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ClearSigningPlugin())
        bridge?.registerPluginInstance(SecureStoragePlugin())
    }
}
