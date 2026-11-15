// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CreatorNFT} from "../../src/CreatorNFT.sol";
import {Marketplace} from "../../src/Marketplace.sol";

/// @dev Drives the marketplace with random sequences of real user actions.
contract Handler is Test {
    Marketplace public market;
    CreatorNFT public nft;
    address public treasury;
    address[] public actors;

    uint256[] public listingIds;
    uint256[] public auctionIds;

    uint256 public ghostDeposited;
    uint256 public ghostWithdrawn;

    constructor(Marketplace market_, CreatorNFT nft_, address treasury_) {
        market = market_;
        nft = nft_;
        treasury = treasury_;
        for (uint256 i; i < 4; ++i) {
            address a = address(uint160(0xA000 + i));
            actors.push(a);
            vm.prank(a);
            nft.setApprovalForAll(address(market), true);
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function auctionCount() external view returns (uint256) {
        return auctionIds.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function mintAndList(uint256 actorSeed, uint96 royaltyBps, uint256 price, bool dutch) external {
        address a = _actor(actorSeed);
        royaltyBps = uint96(bound(royaltyBps, 0, 1_000));
        price = bound(price, 1 gwei, 100 ether);
        vm.startPrank(a);
        uint256 id = nft.mint("ipfs://x", royaltyBps);
        uint256 listingId = dutch
            ? market.listDutch(address(nft), id, price * 2, price, 1 hours)
            : market.list(address(nft), id, price);
        vm.stopPrank();
        listingIds.push(listingId);
    }

    function buy(uint256 actorSeed, uint256 listingSeed, uint256 extra) external {
        if (listingIds.length == 0) return;
        uint256 listingId = listingIds[listingSeed % listingIds.length];
        (address seller,, bool active,,,,,) = market.listings(listingId);
        address a = _actor(actorSeed);
        if (!active || a == seller) return;

        uint256 value = market.priceOf(listingId) + bound(extra, 0, 1 ether);
        vm.deal(a, value);
        vm.prank(a);
        market.buy{value: value}(listingId);
        ghostDeposited += value;
    }

    function createAuction(uint256 actorSeed, uint256 reserve, uint64 duration) external {
        address a = _actor(actorSeed);
        reserve = bound(reserve, 1 gwei, 50 ether);
        duration = uint64(bound(duration, 15 minutes, 3 days));
        vm.startPrank(a);
        uint256 id = nft.mint("ipfs://x", 500);
        auctionIds.push(market.createAuction(address(nft), id, reserve, duration));
        vm.stopPrank();
    }

    function bid(uint256 actorSeed, uint256 auctionSeed, uint256 extra) external {
        if (auctionIds.length == 0) return;
        uint256 auctionId = auctionIds[auctionSeed % auctionIds.length];
        (address seller, uint64 endTime, bool settled,,,,,) = market.auctions(auctionId);
        address a = _actor(actorSeed);
        if (settled || block.timestamp >= endTime || a == seller) return;

        uint256 value = market.minNextBid(auctionId) + bound(extra, 0, 5 ether);
        vm.deal(a, value);
        vm.prank(a);
        market.bid{value: value}(auctionId);
        ghostDeposited += value;
    }

    function settle(uint256 auctionSeed) external {
        if (auctionIds.length == 0) return;
        uint256 auctionId = auctionIds[auctionSeed % auctionIds.length];
        (, uint64 endTime, bool settled,,,,,) = market.auctions(auctionId);
        if (settled) return;
        if (block.timestamp < endTime) vm.warp(endTime);
        market.settleAuction(auctionId);
    }

    function withdraw(uint256 actorSeed, bool useTreasury) external {
        address a = useTreasury ? treasury : _actor(actorSeed);
        uint256 owed = market.credits(a);
        if (owed == 0) return;
        vm.prank(a);
        market.withdraw();
        ghostWithdrawn += owed;
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 days));
    }
}

contract MarketplaceInvariantTest is Test {
    Marketplace internal market;
    CreatorNFT internal nft;
    Handler internal handler;
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        market = new Marketplace(treasury, 250);
        nft = new CreatorNFT();
        handler = new Handler(market, nft, treasury);
        targetContract(address(handler));
    }

    /// Solvency: the contract holds exactly what it owes (credits + live top bids). Never less.
    function invariant_SolventAndExact() public view {
        uint256 owed = market.credits(treasury);
        for (uint256 i; i < handler.actorCount(); ++i) {
            owed += market.credits(handler.actors(i));
        }
        for (uint256 i; i < handler.auctionCount(); ++i) {
            (,, bool settled,,,,, uint256 highestBid) = market.auctions(handler.auctionIds(i));
            if (!settled) owed += highestBid;
        }
        assertEq(address(market).balance, owed);
    }

    /// Every ETH that entered the marketplace either left via withdraw() or is still inside.
    function invariant_EthConservation() public view {
        assertEq(handler.ghostDeposited(), handler.ghostWithdrawn() + address(market).balance);
    }

    /// NFTs in live auctions are always held in escrow by the marketplace.
    function invariant_LiveAuctionsAreEscrowed() public view {
        for (uint256 i; i < handler.auctionCount(); ++i) {
            (,, bool settled, address token,, uint256 tokenId,,) = market.auctions(handler.auctionIds(i));
            if (!settled) assertEq(CreatorNFT(token).ownerOf(tokenId), address(market));
        }
    }
}
