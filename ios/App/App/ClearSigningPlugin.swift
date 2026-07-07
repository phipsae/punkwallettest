import Foundation
import Capacitor
import ClearSigning

// Bridges the ERC-7730 clear-signing engine (Rust, via the ClearSigning
// Swift package) to the web layer. Counterpart: src/lib/clearsigning.ts.
// Both methods always resolve with a uniform envelope (status: clearSigned |
// fallback | error) so the JS side has a single code path.
@objc(ClearSigningPlugin)
public class ClearSigningPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ClearSigningPlugin"
    public let jsName = "ClearSigning"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "formatTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "formatTypedData", returnType: CAPPluginReturnPromise),
    ]

    @objc func formatTransaction(_ call: CAPPluginCall) {
        guard let chainId = call.getInt("chainId"), chainId > 0,
              let to = call.getString("to"),
              let data = call.getString("data") else {
            call.resolve(["status": "error", "errorMessage": "Missing chainId, to, or data"])
            return
        }
        let value = call.getString("value")
        let from = call.getString("from")
        let provider = StaticDataProvider(knownTokens: jsObjects(call.getArray("knownTokens")))

        Task {
            let client = ClearSigningClient(dataProvider: provider)
            do {
                let outcome = try await client.formatCalldata(
                    chainId: UInt64(chainId),
                    to: to,
                    calldataHex: data,
                    valueHex: value,
                    fromAddress: from
                )
                call.resolve(Self.serialize(outcome))
            } catch {
                call.resolve(Self.serializeError(error))
            }
        }
    }

    @objc func formatTypedData(_ call: CAPPluginCall) {
        guard let typedDataJson = call.getString("typedDataJson") else {
            call.resolve(["status": "error", "errorMessage": "Missing typedDataJson"])
            return
        }
        let provider = StaticDataProvider(knownTokens: jsObjects(call.getArray("knownTokens")))

        Task {
            let client = ClearSigningClient(dataProvider: provider)
            do {
                let outcome = try await client.formatTypedData(typedDataJson: typedDataJson)
                call.resolve(Self.serialize(outcome))
            } catch {
                call.resolve(Self.serializeError(error))
            }
        }
    }

    private func jsObjects(_ array: JSArray?) -> [JSObject] {
        (array ?? []).compactMap { $0 as? JSObject }
    }

    // MARK: - Serialization to the JS result envelope

    private static func serialize(_ outcome: FormatOutcome) -> JSObject {
        switch outcome {
        case .clearSigned(let model, let diagnostics):
            var result = serialize(model)
            result["status"] = "clearSigned"
            result["diagnostics"] = diagnostics.map { serialize($0) as JSValue }
            return result
        case .fallback(let model, let reason, let diagnostics):
            var result = serialize(model)
            result["status"] = "fallback"
            result["fallbackReason"] = serialize(reason)
            result["diagnostics"] = diagnostics.map { serialize($0) as JSValue }
            return result
        }
    }

    private static func serialize(_ model: DisplayModel) -> JSObject {
        var result: JSObject = [
            "intent": model.intent,
            "entries": model.entries.map { serialize($0) as JSValue },
        ]
        if let interpolatedIntent = model.interpolatedIntent {
            result["interpolatedIntent"] = interpolatedIntent
        }
        if let owner = model.owner {
            result["owner"] = owner
        }
        if let contractName = model.contractName {
            result["contractName"] = contractName
        }
        return result
    }

    private static func serialize(_ entry: DisplayEntry) -> JSObject {
        switch entry {
        case .item(let item):
            return ["kind": "item", "label": item.label, "value": item.value]
        case .group(let label, let iteration, let items):
            return [
                "kind": "group",
                "label": label,
                "iteration": iteration == .sequential ? "sequential" : "bundled",
                "items": items.map {
                    ["label": $0.label, "value": $0.value] as JSValue
                },
            ]
        case .nested(let label, let intent, let entries):
            return [
                "kind": "nested",
                "label": label,
                "intent": intent,
                "entries": entries.map { serialize($0) as JSValue },
            ]
        }
    }

    private static func serialize(_ diagnostic: FormatDiagnostic) -> JSObject {
        [
            "code": diagnostic.code,
            "severity": diagnostic.severity == .warning ? "warning" : "info",
            "message": diagnostic.message,
        ]
    }

    private static func serialize(_ reason: FallbackReason) -> String {
        switch reason {
        case .descriptorNotFound: return "descriptorNotFound"
        case .formatNotFound: return "formatNotFound"
        case .nestedCallNotClearSigned: return "nestedCallNotClearSigned"
        case .insufficientContext: return "insufficientContext"
        }
    }

    private static func serializeError(_ error: Error) -> JSObject {
        if let failure = error as? FormatFailure {
            return [
                "status": "error",
                "errorMessage": failure.message,
                "retryable": failure.retryable,
            ]
        }
        return ["status": "error", "errorMessage": String(describing: error)]
    }
}
