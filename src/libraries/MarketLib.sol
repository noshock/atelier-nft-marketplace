// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title MarketLib
/// @notice Stateless helpers used by the Marketplace.
/// @dev Functions are `external`, so this library is deployed as its own contract and linked into
///      the Marketplace. That keeps the Marketplace's deployment under the per-transaction gas cap
///      (EIP-7825), since contract creation is charged per byte of deployed code.
library MarketLib {
    using ERC165Checker for address;

    /// @notice True if `signature` is `signer`'s signature over `digest`. Supports EOAs (ECDSA)
    ///         and smart-contract wallets (ERC-1271).
    function isValidSignature(address signer, bytes32 digest, bytes calldata signature)
        external
        view
        returns (bool)
    {
        return SignatureChecker.isValidSignatureNow(signer, digest, signature);
    }

    /// @notice Reads ERC-2981 defensively: collections that don't implement it, revert, or ask for
    ///         more than `maxBps` can never break or drain a sale.
    function royaltyInfo(address nft, uint256 tokenId, uint256 price, uint256 maxBps)
        external
        view
        returns (address receiver, uint256 amount)
    {
        if (!nft.supportsInterface(type(IERC2981).interfaceId)) return (address(0), 0);
        try IERC2981(nft).royaltyInfo(tokenId, price) returns (address r, uint256 a) {
            if (r == address(0) || a == 0) return (address(0), 0);
            uint256 cap = (price * maxBps) / 10_000;
            return (r, a > cap ? cap : a);
        } catch {
            return (address(0), 0);
        }
    }
}
