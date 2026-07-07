import Foundation
import Capacitor
import ClearSigning

// Answers the clear-signing engine's synchronous data callbacks from token
// metadata the web layer passes with each plugin call. Everything else
// returns nil - missing metadata surfaces as diagnostics, not failures.
final class StaticDataProvider: DataProviderFfi, @unchecked Sendable {
    private let tokens: [String: TokenMetaFfi]

    init(knownTokens: [JSObject]) {
        var map: [String: TokenMetaFfi] = [:]
        for token in knownTokens {
            guard let chainId = Self.intValue(token["chainId"]),
                  let address = token["address"] as? String,
                  let symbol = token["symbol"] as? String,
                  let decimals = Self.intValue(token["decimals"]),
                  let name = token["name"] as? String else { continue }
            map["\(chainId):\(address.lowercased())"] = TokenMetaFfi(
                symbol: symbol,
                decimals: UInt8(clamping: decimals),
                name: name
            )
        }
        tokens = map
    }

    private static func intValue(_ value: JSValue?) -> Int? {
        if let number = value as? NSNumber { return number.intValue }
        return value as? Int
    }

    func resolveToken(chainId: UInt64, address: String) -> TokenMetaFfi? {
        tokens["\(chainId):\(address.lowercased())"]
    }

    func resolveEnsName(address: String, chainId: UInt64, types: [String]?) -> String? {
        nil
    }

    func resolveLocalName(address: String, chainId: UInt64, types: [String]?) -> String? {
        nil
    }

    func resolveNftCollectionName(collectionAddress: String, chainId: UInt64) -> String? {
        nil
    }

    func resolveBlockTimestamp(chainId: UInt64, blockNumber: UInt64) -> UInt64? {
        nil
    }

    func getImplementationAddress(chainId: UInt64, address: String) -> String? {
        nil
    }
}
