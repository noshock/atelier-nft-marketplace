// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaseTest} from "./Base.t.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {HostileRoyaltyNFT, PlainNFT, ReentrantBuyer, EthRejecter} from "./mocks/Mocks.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract MarketplaceTest is BaseTest {
    // ---------------------------------------------------------------------------------------------
    // Fixed-price listings
    // ---------------------------------------------------------------------------------------------

    function test_ListAndBuy_SplitsRoyaltyFeeAndProceeds() public {
        uint256 id = _mintApproved();
        vm.prank(creator);
        uint256 listingId = market.list(address(nft), id, 1 ether);

        vm.prank(buyer);
        market.buy{value: 1 ether}(listingId);

        assertEq(nft.ownerOf(id), buyer);
        assertEq(market.credits(treasury), 0.025 ether); // 2.5% fee
        // creator is both seller and royalty receiver on a primary sale: 5% royalty + 92.5% proceeds
        assertEq(market.credits(creator), 0.975 ether);
        assertEq(address(market).balance, 1 ether);
        (,, bool active,,,,,) = market.listings(listingId);
        assertFalse(active);
    }

    function test_SecondarySale_PaysCreatorRoyalty() public {
        uint256 id = _mintApproved();
        address collector = makeAddr("collector");
        vm.prank(creator);
        nft.transferFrom(creator, collector, id);

        vm.startPrank(collector);
        nft.approve(address(market), id);
        uint256 listingId = market.list(address(nft), id, 2 ether);
        vm.stopPrank();

        vm.prank(buyer);
        market.buy{value: 2 ether}(listingId);

        assertEq(market.credits(creator), 0.1 ether); // 5% royalty
        assertEq(market.credits(treasury), 0.05 ether); // 2.5% fee
        assertEq(market.credits(collector), 1.85 ether); // remainder
    }

    function test_Buy_OverpaymentIsCreditedBack() public {
        uint256 id = _mintApproved();
        vm.prank(creator);
        uint256 listingId = market.list(address(nft), id, 1 ether);

        vm.prank(buyer);
        market.buy{value: 1.3 ether}(listingId);
        assertEq(market.credits(buyer), 0.3 ether);
    }

    function test_RevertWhen_ListWithoutApproval() public {
        vm.prank(creator);
        uint256 id = nft.mint("x", 0);
        vm.expectRevert(Marketplace.MarketplaceNotApproved.selector);
        vm.prank(creator);
        market.list(address(nft), id, 1 ether);
    }

    function test_RevertWhen_ListTokenYouDontOwn() public {
        uint256 id = _mintApproved();
        vm.expectRevert(Marketplace.NotTokenOwner.selector);
        vm.prank(buyer);
        market.list(address(nft), id, 1 ether);
    }

    function test_RevertWhen_ListAtZero() public {
        uint256 id = _mintApproved();
        vm.expectRevert(Marketplace.ZeroPrice.selector);
        vm.prank(creator);
        market.list(address(nft), id, 0);
    }

    function test_RevertWhen_Underpaying() public {
        uint256 id = _mintApproved();
        vm.prank(creator);
        uint256 listingId = market.list(address(nft), id, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.InsufficientPayment.selector, 1 ether, 0.5 ether));
        vm.prank(buyer);
        market.buy{value: 0.5 ether}(listingId);
    }

    function test_RevertWhen_SellerBuysOwnListing() public {
        uint256 id = _mintApproved();
        vm.deal(creator, 1 ether);
        vm.startPrank(creator);
        uint256 listingId = market.list(address(nft), id, 1 ether);
        vm.expectRevert(Marketplace.SellerCannotBuy.selector);
        market.buy{value: 1 ether}(listingId);
        vm.stopPrank();
    }

    function test_RevertWhen_ListingIsStale() public {
        uint256 id = _mintApproved();
        vm.startPrank(creator);
        uint256 listingId = market.list(address(nft), id, 1 ether);
        nft.transferFrom(creator, bidder2, id); // seller moved the NFT elsewhere
        vm.stopPrank();

        vm.expectRevert(Marketplace.ListingStale.selector);
        vm.prank(buyer);
        market.buy{value: 1 ether}(listingId);
    }

    function test_RevertWhen_BuyingTwice() public {
        uint256 id = _mintApproved();
        vm.prank(creator);
        uint256 listingId = market.list(address(nft), id, 1 ether);
        vm.prank(buyer);
        market.buy{value: 1 ether}(listingId);

        vm.expectRevert(abi.encodeWithSelector(Marketplace.ListingNotActive.selector, listingId));
        vm.prank(bidder2);
        market.buy{value: 1 ether}(listingId);
    }

    function test_UpdatePriceAndCancel() public {
        uint256 id = _mintApproved();
        vm.startPrank(creator);
        uint256 listingId = market.list(address(nft), id, 1 ether);
        market.updatePrice(listingId, 3 ether);
        assertEq(market.priceOf(listingId), 3 ether);
        market.cancelListing(listingId);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(Marketplace.ListingNotActive.selector, listingId));
        vm.prank(buyer);
        market.buy{value: 3 ether}(listingId);
    }

    function test_RevertWhen_StrangerCancels() public {
        uint256 id = _mintApproved();
        vm.prank(creator);
        uint256 listingId = market.list(address(nft), id, 1 ether);
        vm.expectRevert(Marketplace.NotSeller.selector);
        vm.prank(buyer);
        market.cancelListing(listingId);
    }

    // ---------------------------------------------------------------------------------------------
    // Dutch auctions
    // ---------------------------------------------------------------------------------------------

    function test_Dutch_PriceDecaysLinearlyThenFloors() public {
        uint256 id = _mintApproved();
        vm.prank(creator);
        uint256 listingId = market.listDutch(address(nft), id, 10 ether, 2 ether, 1 hours);

        assertEq(market.priceOf(listingId), 10 ether);
        skip(30 minutes);
        assertEq(market.priceOf(listingId), 6 ether);
        skip(30 minutes);
        assertEq(market.priceOf(listingId), 2 ether);
        skip(10 days);
        assertEq(market.priceOf(listingId), 2 ether);
    }

    function test_Dutch_BuyerPaysCurrentPriceAndGetsBufferBack() public {
        uint256 id = _mintApproved();
        vm.prank(creator);
        uint256 listingId = market.listDutch(address(nft), id, 10 ether, 2 ether, 1 hours);
        skip(45 minutes); // price = 4 ether

        vm.prank(buyer);
        market.buy{value: 5 ether}(listingId);
        assertEq(nft.ownerOf(id), buyer);
        assertEq(market.credits(buyer), 1 ether);
    }

    function test_RevertWhen_DutchUpdatePrice() public {
        uint256 id = _mintApproved();
        vm.startPrank(creator);
        uint256 listingId = market.listDutch(address(nft), id, 10 ether, 2 ether, 1 hours);
        vm.expectRevert(Marketplace.NotFixedPrice.selector);
        market.updatePrice(listingId, 5 ether);
        vm.stopPrank();
    }

    function test_RevertWhen_DutchInvalidParams() public {
        uint256 id = _mintApproved();
        vm.startPrank(creator);
        vm.expectRevert(Marketplace.InvalidPriceRange.selector);
        market.listDutch(address(nft), id, 1 ether, 2 ether, 1 hours);
        vm.expectRevert(Marketplace.InvalidDuration.selector);
        market.listDutch(address(nft), id, 2 ether, 1 ether, 1 minutes);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------
    // Signed (gasless) orders
    // ---------------------------------------------------------------------------------------------

    function _signedOrder(uint256 id, uint256 price, uint256 nonce)
        internal
        view
        returns (Marketplace.Order memory order, bytes memory sig)
    {
        order = Marketplace.Order({
            seller: creator,
            nft: address(nft),
            tokenId: id,
            price: price,
            nonce: nonce,
            deadline: block.timestamp + 1 days
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(creatorKey, market.hashOrder(order));
        sig = abi.encodePacked(r, s, v);
    }

    function test_FulfillSignedOrder() public {
        uint256 id = _mintApproved();
        (Marketplace.Order memory order, bytes memory sig) = _signedOrder(id, 1 ether, 1);

        vm.prank(buyer);
        market.fulfillOrder{value: 1 ether}(order, sig);

        assertEq(nft.ownerOf(id), buyer);
        assertTrue(market.nonceUsed(creator, 1));
        assertEq(market.credits(creator), 0.975 ether);
    }

    function test_RevertWhen_OrderReplayed() public {
        uint256 id = _mintApproved();
        (Marketplace.Order memory order, bytes memory sig) = _signedOrder(id, 1 ether, 1);
        vm.prank(buyer);
        market.fulfillOrder{value: 1 ether}(order, sig);

        // buyer relists back to creator scenario aside, the same signature can never be reused
        vm.expectRevert(Marketplace.NonceAlreadyUsed.selector);
        vm.prank(bidder2);
        market.fulfillOrder{value: 1 ether}(order, sig);
    }

    function test_RevertWhen_OrderTampered() public {
        uint256 id = _mintApproved();
        (Marketplace.Order memory order, bytes memory sig) = _signedOrder(id, 1 ether, 1);
        order.price = 0.01 ether; // buyer tries to lower the price

        vm.expectRevert(Marketplace.InvalidSignature.selector);
        vm.prank(buyer);
        market.fulfillOrder{value: 0.01 ether}(order, sig);
    }

    function test_RevertWhen_OrderExpired() public {
        uint256 id = _mintApproved();
        (Marketplace.Order memory order, bytes memory sig) = _signedOrder(id, 1 ether, 1);
        skip(1 days + 1);
        vm.expectRevert(Marketplace.OrderExpired.selector);
        vm.prank(buyer);
        market.fulfillOrder{value: 1 ether}(order, sig);
    }

    function test_RevertWhen_OrderCancelled() public {
        uint256 id = _mintApproved();
        (Marketplace.Order memory order, bytes memory sig) = _signedOrder(id, 1 ether, 7);
        vm.prank(creator);
        market.cancelOrder(7);

        vm.expectRevert(Marketplace.NonceAlreadyUsed.selector);
        vm.prank(buyer);
        market.fulfillOrder{value: 1 ether}(order, sig);
    }

    function test_RevertWhen_OrderWrongPayment() public {
        uint256 id = _mintApproved();
        (Marketplace.Order memory order, bytes memory sig) = _signedOrder(id, 1 ether, 1);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.IncorrectPayment.selector, 1 ether, 2 ether));
        vm.prank(buyer);
        market.fulfillOrder{value: 2 ether}(order, sig);
    }

    // ---------------------------------------------------------------------------------------------
    // English auctions
    // ---------------------------------------------------------------------------------------------

    function _auction() internal returns (uint256 tokenId, uint256 auctionId) {
        tokenId = _mintApproved();
        vm.prank(creator);
        auctionId = market.createAuction(address(nft), tokenId, 1 ether, 1 days);
    }

    function test_Auction_EscrowsNft() public {
        (uint256 id,) = _auction();
        assertEq(nft.ownerOf(id), address(market));
    }

    function test_Auction_OutbidRefundsPreviousBidder() public {
        (, uint256 auctionId) = _auction();
        vm.prank(buyer);
        market.bid{value: 1 ether}(auctionId);
        vm.prank(bidder2);
        market.bid{value: 1.05 ether}(auctionId);

        assertEq(market.credits(buyer), 1 ether);
        (,,,, address top,,, uint256 topBid) = market.auctions(auctionId);
        assertEq(top, bidder2);
        assertEq(topBid, 1.05 ether);
    }

    function test_RevertWhen_BidBelowReserveOrIncrement() public {
        (, uint256 auctionId) = _auction();
        vm.expectRevert(abi.encodeWithSelector(Marketplace.BidTooLow.selector, 1 ether, 0.9 ether));
        vm.prank(buyer);
        market.bid{value: 0.9 ether}(auctionId);

        vm.prank(buyer);
        market.bid{value: 1 ether}(auctionId);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.BidTooLow.selector, 1.05 ether, 1.04 ether));
        vm.prank(bidder2);
        market.bid{value: 1.04 ether}(auctionId);
    }

    function test_Auction_AntiSnipingExtendsEndTime() public {
        (, uint256 auctionId) = _auction();
        (, uint64 endTime,,,,,,) = market.auctions(auctionId);

        vm.warp(endTime - 2 minutes);
        vm.prank(buyer);
        market.bid{value: 1 ether}(auctionId);

        (, uint64 newEnd,,,,,,) = market.auctions(auctionId);
        assertEq(newEnd, block.timestamp + 10 minutes);
    }

    function test_Auction_SettleWithWinner() public {
        (uint256 id, uint256 auctionId) = _auction();
        vm.prank(buyer);
        market.bid{value: 2 ether}(auctionId);

        vm.expectRevert(Marketplace.AuctionNotEnded.selector);
        market.settleAuction(auctionId);

        skip(1 days);
        market.settleAuction(auctionId); // anyone can settle
        assertEq(nft.ownerOf(id), buyer);
        assertEq(market.credits(creator), 1.95 ether);
        assertEq(market.credits(treasury), 0.05 ether);

        vm.expectRevert(Marketplace.AuctionAlreadySettled.selector);
        market.settleAuction(auctionId);
    }

    function test_Auction_SettleWithoutBidsReturnsNft() public {
        (uint256 id, uint256 auctionId) = _auction();
        skip(1 days);
        market.settleAuction(auctionId);
        assertEq(nft.ownerOf(id), creator);
    }

    function test_RevertWhen_BidAfterEnd() public {
        (, uint256 auctionId) = _auction();
        skip(1 days);
        vm.expectRevert(Marketplace.AuctionHasEnded.selector);
        vm.prank(buyer);
        market.bid{value: 1 ether}(auctionId);
    }

    function test_CancelAuction_OnlyWithoutBids() public {
        (uint256 id, uint256 auctionId) = _auction();
        vm.expectRevert(Marketplace.NotSeller.selector);
        vm.prank(buyer);
        market.cancelAuction(auctionId);

        vm.prank(creator);
        market.cancelAuction(auctionId);
        assertEq(nft.ownerOf(id), creator);
    }

    function test_RevertWhen_CancelAuctionWithBids() public {
        (, uint256 auctionId) = _auction();
        vm.prank(buyer);
        market.bid{value: 1 ether}(auctionId);
        vm.expectRevert(Marketplace.AuctionHasBids.selector);
        vm.prank(creator);
        market.cancelAuction(auctionId);
    }

    function test_RevertWhen_AuctionDoesNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(Marketplace.AuctionNotFound.selector, 99));
        market.bid{value: 1 ether}(99);
    }

    // ---------------------------------------------------------------------------------------------
    // Withdrawals & security
    // ---------------------------------------------------------------------------------------------

    function test_Withdraw() public {
        test_ListAndBuy_SplitsRoyaltyFeeAndProceeds();
        uint256 before = creator.balance;
        vm.prank(creator);
        market.withdraw();
        assertEq(creator.balance - before, 0.975 ether);
        assertEq(market.credits(creator), 0);

        vm.expectRevert(Marketplace.NothingToWithdraw.selector);
        vm.prank(creator);
        market.withdraw();
    }

    function test_ReentrancyFromReceiveHookIsBlocked() public {
        uint256 id = _mintApproved();
        vm.prank(creator);
        uint256 listingId = market.list(address(nft), id, 1 ether);

        ReentrantBuyer attacker = new ReentrantBuyer(market);
        vm.deal(address(attacker), 2 ether);
        attacker.attack{value: 2 ether}(listingId); // 1 ether overpaid -> credited, attacker tries to grab it mid-buy

        assertTrue(attacker.reentryBlocked());
        assertEq(nft.ownerOf(id), address(attacker));
        assertEq(market.credits(address(attacker)), 1 ether); // still owed, not double-spent
    }

    function test_EthRejectingBidderCannotBlockAuction() public {
        (, uint256 auctionId) = _auction();
        EthRejecter griefer = new EthRejecter();
        vm.deal(address(griefer), 1 ether);
        griefer.bid{value: 1 ether}(market, auctionId);

        // With push refunds this would revert forever; with pull payments the auction carries on.
        vm.prank(buyer);
        market.bid{value: 2 ether}(auctionId);
        assertEq(market.credits(address(griefer)), 1 ether);
    }

    function test_GreedyRoyaltyIsCapped() public {
        HostileRoyaltyNFT hostile = new HostileRoyaltyNFT(HostileRoyaltyNFT.Mode.Greedy);
        hostile.mint(creator, 1);
        vm.startPrank(creator);
        hostile.setApprovalForAll(address(market), true);
        uint256 listingId = market.list(address(hostile), 1, 1 ether);
        vm.stopPrank();

        vm.prank(buyer);
        market.buy{value: 1 ether}(listingId);
        assertEq(market.credits(address(0xBEEF)), 0.1 ether); // capped at 10%, not 100%
        assertEq(market.credits(creator), 0.875 ether);
    }

    function test_RevertingRoyaltyIsIgnored() public {
        HostileRoyaltyNFT hostile = new HostileRoyaltyNFT(HostileRoyaltyNFT.Mode.Reverts);
        hostile.mint(creator, 1);
        (address r, uint256 royalty,, uint256 net) = market.quoteSale(address(hostile), 1, 1 ether);
        assertEq(r, address(0));
        assertEq(royalty, 0);
        assertEq(net, 0.975 ether);
    }

    function test_CollectionWithoutRoyaltiesWorks() public {
        PlainNFT plain = new PlainNFT();
        plain.mint(creator, 1);
        vm.startPrank(creator);
        plain.approve(address(market), 1);
        uint256 listingId = market.list(address(plain), 1, 1 ether);
        vm.stopPrank();
        vm.prank(buyer);
        market.buy{value: 1 ether}(listingId);
        assertEq(plain.ownerOf(1), buyer);
        assertEq(market.credits(creator), 0.975 ether);
    }

    // ---------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------

    function test_OnlyOwnerAdmin() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        vm.prank(buyer);
        market.setFee(100);

        vm.prank(owner);
        market.setFee(100);
        assertEq(market.feeBps(), 100);

        vm.expectRevert(abi.encodeWithSelector(Marketplace.FeeTooHigh.selector, 501));
        vm.prank(owner);
        market.setFee(501);

        vm.expectRevert(Marketplace.ZeroAddress.selector);
        vm.prank(owner);
        market.setFeeRecipient(address(0));
    }

    function test_PauseBlocksTradingButNotExits() public {
        uint256 id = _mintApproved();
        vm.prank(creator);
        uint256 listingId = market.list(address(nft), id, 1 ether);

        vm.prank(owner);
        market.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(buyer);
        market.buy{value: 1 ether}(listingId);

        // sellers can still cancel while paused
        vm.prank(creator);
        market.cancelListing(listingId);
    }

    // ---------------------------------------------------------------------------------------------
    // Fuzz
    // ---------------------------------------------------------------------------------------------

    /// The three payouts always add up to exactly the sale price - no wei created or lost.
    function testFuzz_SaleSplitConservesValue(uint256 price, uint96 royaltyBps, uint256 feeBps) public {
        price = bound(price, 1, 1e30);
        royaltyBps = uint96(bound(royaltyBps, 0, 1_000));
        feeBps = bound(feeBps, 0, 500);

        vm.prank(owner);
        market.setFee(feeBps);
        vm.prank(creator);
        uint256 id = nft.mint("x", royaltyBps);

        (, uint256 royalty, uint256 fee, uint256 net) = market.quoteSale(address(nft), id, price);
        assertEq(royalty + fee + net, price);
        assertLe(royalty, (price * 1_000) / 10_000);
        assertLe(fee, (price * 500) / 10_000);
    }

    /// Dutch price never leaves [endPrice, startPrice] and never increases over time.
    function testFuzz_DutchPriceBoundedAndMonotonic(
        uint128 startPrice,
        uint128 endPrice,
        uint64 duration,
        uint64 t1,
        uint64 t2
    ) public {
        endPrice = uint128(bound(endPrice, 1, type(uint128).max - 1));
        startPrice = uint128(bound(startPrice, uint256(endPrice) + 1, type(uint128).max));
        duration = uint64(bound(duration, 15 minutes, 30 days));
        t1 = uint64(bound(t1, 0, 60 days));
        t2 = uint64(bound(t2, t1, 60 days));

        uint256 id = _mintApproved();
        vm.prank(creator);
        uint256 listingId = market.listDutch(address(nft), id, startPrice, endPrice, duration);
        uint256 start = block.timestamp;

        vm.warp(start + t1);
        uint256 p1 = market.priceOf(listingId);
        vm.warp(start + t2);
        uint256 p2 = market.priceOf(listingId);

        assertLe(p2, p1);
        assertGe(p2, endPrice);
        assertLe(p1, startPrice);
    }

    /// However bidding goes, the winner's bid is the max and every loser is fully refundable.
    function testFuzz_AuctionRefundsAllLosers(uint256[5] memory raises) public {
        (, uint256 auctionId) = _auction();
        uint256 totalLosing;
        uint256 lastBid;
        address lastBidder;

        for (uint256 i; i < raises.length; ++i) {
            address b = address(uint160(0x1000 + i));
            uint256 amount = market.minNextBid(auctionId) + bound(raises[i], 0, 10 ether);
            vm.deal(b, amount);
            vm.prank(b);
            market.bid{value: amount}(auctionId);
            if (lastBidder != address(0)) totalLosing += lastBid;
            lastBid = amount;
            lastBidder = b;
        }

        uint256 refunds;
        for (uint256 i; i < raises.length; ++i) {
            refunds += market.credits(address(uint160(0x1000 + i)));
        }
        assertEq(refunds, totalLosing);
        assertEq(address(market).balance, totalLosing + lastBid);
    }
}
