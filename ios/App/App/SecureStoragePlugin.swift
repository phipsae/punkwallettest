import Foundation
import Capacitor
import Security

// Keychain-backed storage for small secrets (the AES-GCM-encrypted
// imported-wallet key blobs). Items are device-only and non-migrating:
// kSecAttrAccessibleWhenUnlockedThisDeviceOnly, never synchronized, so they
// do not travel in backups or to other devices. Counterpart:
// src/lib/securestorage.ts.
@objc(SecureStoragePlugin)
public class SecureStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecureStoragePlugin"
    public let jsName = "SecureStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]

    private static let service = "com.punkwallet.app.securestorage"

    private func baseQuery(forKey key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: key,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("Missing key")
            return
        }
        var query = baseQuery(forKey: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data,
                  let value = String(data: data, encoding: .utf8) else {
                call.reject("Keychain item is not valid UTF-8")
                return
            }
            call.resolve(["value": value])
        case errSecItemNotFound:
            call.resolve(["value": NSNull()])
        default:
            // Fail loudly - a Keychain error must never read as "no data",
            // or an imported wallet would look unrecoverable
            call.reject("Keychain read failed (OSStatus \(status))")
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"),
              let value = call.getString("value") else {
            call.reject("Missing key or value")
            return
        }
        guard let data = value.data(using: .utf8) else {
            call.reject("Value is not valid UTF-8")
            return
        }
        // Delete-then-add keeps the accessibility attribute authoritative
        SecItemDelete(baseQuery(forKey: key) as CFDictionary)
        var attributes = baseQuery(forKey: key)
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] =
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("Keychain write failed (OSStatus \(status))")
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("Missing key")
            return
        }
        let status = SecItemDelete(baseQuery(forKey: key) as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve()
        } else {
            call.reject("Keychain delete failed (OSStatus \(status))")
        }
    }
}
