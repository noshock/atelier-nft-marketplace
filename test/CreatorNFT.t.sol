// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaseTest} from "./Base.t.sol";
import {CreatorNFT} from "../src/CreatorNFT.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

contract CreatorNFTTest is BaseTest {
    function test_MintSetsOwnerUriAndRoyalty() public {
        vm.prank(creator);
        uint256 id = nft.mint("ipfs://abc", 750);

        assertEq(id, 1);
        assertEq(nft.ownerOf(id), creator);
        assertEq(nft.tokenURI(id), "ipfs://abc");
        assertEq(nft.totalMinted(), 1);

        (address receiver, uint256 amount) = nft.royaltyInfo(id, 1 ether);
        assertEq(receiver, creator);
        assertEq(amount, 0.075 ether);
    }

    function test_TokenIdsIncrement() public {
        vm.startPrank(creator);
        assertEq(nft.mint("a", 0), 1);
        assertEq(nft.mint("b", 0), 2);
        vm.stopPrank();
        assertEq(nft.totalMinted(), 2);
    }

    function test_RevertWhen_RoyaltyAboveCap() public {
        vm.expectRevert(abi.encodeWithSelector(CreatorNFT.RoyaltyTooHigh.selector, 1_001, 1_000));
        vm.prank(creator);
        nft.mint("ipfs://abc", 1_001);
    }

    function test_RevertWhen_EmptyUri() public {
        vm.expectRevert(CreatorNFT.EmptyTokenURI.selector);
        nft.mint("", 100);
    }

    function test_SupportsInterfaces() public view {
        assertTrue(nft.supportsInterface(type(IERC2981).interfaceId));
        assertTrue(nft.supportsInterface(type(IERC721).interfaceId));
        assertTrue(nft.supportsInterface(bytes4(0x49064906))); // ERC-4906 metadata updates
    }

    function testFuzz_RoyaltyMath(uint96 bps, uint128 price) public {
        bps = uint96(bound(bps, 0, 1_000));
        vm.prank(creator);
        uint256 id = nft.mint("x", bps);
        (, uint256 amount) = nft.royaltyInfo(id, price);
        assertEq(amount, (uint256(price) * bps) / 10_000);
    }
}
