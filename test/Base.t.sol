// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CreatorNFT} from "../src/CreatorNFT.sol";
import {Marketplace} from "../src/Marketplace.sol";

abstract contract BaseTest is Test {
    CreatorNFT internal nft;
    Marketplace internal market;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator;
    uint256 internal creatorKey;
    address internal buyer = makeAddr("buyer");
    address internal bidder2 = makeAddr("bidder2");

    uint256 internal constant FEE_BPS = 250; // 2.5%
    uint96 internal constant ROYALTY_BPS = 500; // 5%

    function setUp() public virtual {
        (creator, creatorKey) = makeAddrAndKey("creator");
        vm.prank(owner);
        market = new Marketplace(treasury, FEE_BPS);
        nft = new CreatorNFT();

        vm.deal(buyer, 1_000 ether);
        vm.deal(bidder2, 1_000 ether);
    }

    /// Mint a token as `creator` and approve the marketplace for it.
    function _mintApproved() internal returns (uint256 tokenId) {
        vm.startPrank(creator);
        tokenId = nft.mint("ipfs://token", ROYALTY_BPS);
        nft.setApprovalForAll(address(market), true);
        vm.stopPrank();
    }
}
