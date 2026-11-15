// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Marketplace} from "../../src/Marketplace.sol";

/// ERC-721 with a configurable, possibly hostile, ERC-2981 implementation.
contract HostileRoyaltyNFT is ERC721, IERC2981 {
    enum Mode {
        Greedy, // asks for 100% of the sale
        Reverts // royaltyInfo always reverts
    }

    Mode public mode;

    constructor(Mode mode_) ERC721("Hostile", "HST") {
        mode = mode_;
    }

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) {
        if (mode == Mode.Reverts) revert("nope");
        return (address(0xBEEF), salePrice);
    }

    function supportsInterface(bytes4 id) public view override(ERC721, IERC165) returns (bool) {
        return id == type(IERC2981).interfaceId || super.supportsInterface(id);
    }
}

/// Plain ERC-721 with no royalty support at all.
contract PlainNFT is ERC721 {
    constructor() ERC721("Plain", "PLN") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

/// Buyer contract that tries to re-enter the marketplace from the ERC-721 receive hook.
contract ReentrantBuyer is IERC721Receiver {
    Marketplace public immutable market;
    uint256 public targetListing;
    bool public reentryBlocked;

    constructor(Marketplace market_) {
        market = market_;
    }

    function attack(uint256 listingId) external payable {
        targetListing = listingId;
        market.buy{value: msg.value}(listingId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        try market.withdraw() {
            reentryBlocked = false;
        } catch (bytes memory reason) {
            reentryBlocked = bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()"));
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// Account that refuses to receive ETH (e.g. a broken multisig).
contract EthRejecter {
    function bid(Marketplace market, uint256 auctionId) external payable {
        market.bid{value: msg.value}(auctionId);
    }

    receive() external payable {
        revert("no ETH");
    }
}
