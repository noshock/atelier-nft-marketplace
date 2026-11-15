// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Atelier Marketplace
/// @notice A marketplace for any ERC-721 collection supporting:
///         1. Fixed-price listings
///         2. Dutch auctions (price decays linearly from a start to a floor price)
///         3. English auctions (escrowed NFT, minimum bid increment, anti-sniping extension)
///         4. Gasless EIP-712 signed orders (seller signs off-chain, buyer submits on-chain)
///
///         Every sale pays ERC-2981 royalties (capped) and a protocol fee. All payouts use the
///         pull-payment pattern: proceeds are credited and recipients call `withdraw()`. This means
///         a recipient that rejects ETH can never block a sale or an auction settlement.
contract Marketplace is EIP712, Ownable, Pausable, ReentrancyGuard {
    using ERC165Checker for address;

    // ---------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 500; // 5%
    uint256 public constant MAX_ROYALTY_BPS = 1_000; // 10%, protects sellers from hostile royalty configs
    uint256 public constant MIN_BID_INCREMENT_BPS = 500; // each bid must beat the last by 5%
    uint64 public constant MIN_AUCTION_DURATION = 15 minutes;
    uint64 public constant MAX_AUCTION_DURATION = 30 days;
    uint64 public constant ANTI_SNIPE_WINDOW = 10 minutes;

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address seller,address nft,uint256 tokenId,uint256 price,uint256 nonce,uint256 deadline)"
    );

    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    /// @dev A fixed-price listing is a Dutch listing where startPrice == endPrice and endTime == startTime.
    struct Listing {
        address seller;
        uint64 startTime;
        bool active;
        address nft;
        uint64 endTime;
        uint256 tokenId;
        uint256 startPrice;
        uint256 endPrice;
    }

    struct Auction {
        address seller;
        uint64 endTime;
        bool settled;
        address nft;
        address highestBidder;
        uint256 tokenId;
        uint256 reservePrice;
        uint256 highestBid;
    }

    /// @notice Off-chain order signed by the seller with EIP-712.
    struct Order {
        address seller;
        address nft;
        uint256 tokenId;
        uint256 price;
        uint256 nonce;
        uint256 deadline;
    }

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    uint256 public feeBps;
    address public feeRecipient;

    uint256 public listingCount;
    uint256 public auctionCount;

    mapping(uint256 listingId => Listing) public listings;
    mapping(uint256 auctionId => Auction) public auctions;
    mapping(address seller => mapping(uint256 nonce => bool used)) public nonceUsed;

    /// @notice ETH each account can withdraw (sale proceeds, royalties, fees, outbid refunds).
    mapping(address account => uint256 amount) public credits;

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    event Listed(
        uint256 indexed listingId,
        address indexed seller,
        address indexed nft,
        uint256 tokenId,
        uint256 startPrice,
        uint256 endPrice,
        uint64 endTime
    );
    event ListingPriceUpdated(uint256 indexed listingId, uint256 newPrice);
    event ListingCancelled(uint256 indexed listingId);
    event ListingSold(uint256 indexed listingId, address indexed buyer, uint256 price);

    event OrderFilled(
        bytes32 indexed orderHash, address indexed seller, address indexed buyer, uint256 price
    );
    event OrderCancelled(address indexed seller, uint256 nonce);

    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed seller,
        address indexed nft,
        uint256 tokenId,
        uint256 reservePrice,
        uint64 endTime
    );
    event BidPlaced(uint256 indexed auctionId, address indexed bidder, uint256 amount);
    event AuctionExtended(uint256 indexed auctionId, uint64 newEndTime);
    event AuctionSettled(uint256 indexed auctionId, address indexed winner, uint256 amount);
    event AuctionCancelled(uint256 indexed auctionId);

    event Sale(
        address indexed nft,
        uint256 indexed tokenId,
        address seller,
        address buyer,
        uint256 price,
        address royaltyReceiver,
        uint256 royaltyAmount,
        uint256 fee
    );
    event Withdrawal(address indexed account, uint256 amount);
    event FeeUpdated(uint256 feeBps);
    event FeeRecipientUpdated(address feeRecipient);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    error ZeroPrice();
    error ZeroAddress();
    error FeeTooHigh(uint256 feeBps);
    error InvalidPriceRange();
    error InvalidDuration();
    error NotTokenOwner();
    error MarketplaceNotApproved();
    error NotSeller();
    error SellerCannotBuy();
    error ListingNotActive(uint256 listingId);
    error ListingStale();
    error NotFixedPrice();
    error InsufficientPayment(uint256 required, uint256 sent);
    error IncorrectPayment(uint256 required, uint256 sent);
    error OrderExpired();
    error NonceAlreadyUsed();
    error InvalidSignature();
    error AuctionNotFound(uint256 auctionId);
    error AuctionAlreadySettled();
    error AuctionHasEnded();
    error AuctionNotEnded();
    error AuctionHasBids();
    error BidTooLow(uint256 minBid, uint256 sent);
    error NothingToWithdraw();
    error TransferFailed();

    // ---------------------------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------------------------

    constructor(address feeRecipient_, uint256 feeBps_)
        EIP712("Atelier Marketplace", "1")
        Ownable(msg.sender)
    {
        _setFeeRecipient(feeRecipient_);
        _setFee(feeBps_);
    }

    // =============================================================================================
    // Fixed-price & Dutch listings (NFT stays in the seller's wallet until sold)
    // =============================================================================================

    /// @notice List a token at a fixed price. Requires the marketplace to be approved for the token.
    function list(address nft, uint256 tokenId, uint256 price) external whenNotPaused returns (uint256) {
        if (price == 0) revert ZeroPrice();
        return _createListing(nft, tokenId, price, price, 0);
    }

    /// @notice List a token in a Dutch auction: price falls linearly from `startPrice` to `endPrice`
    ///         over `duration` seconds, then stays at `endPrice` until bought or cancelled.
    function listDutch(address nft, uint256 tokenId, uint256 startPrice, uint256 endPrice, uint64 duration)
        external
        whenNotPaused
        returns (uint256)
    {
        if (endPrice == 0) revert ZeroPrice();
        if (startPrice <= endPrice) revert InvalidPriceRange();
        if (duration < MIN_AUCTION_DURATION || duration > MAX_AUCTION_DURATION) revert InvalidDuration();
        return _createListing(nft, tokenId, startPrice, endPrice, duration);
    }

    /// @notice Current price of a listing (constant for fixed-price, decaying for Dutch).
    function priceOf(uint256 listingId) public view returns (uint256) {
        Listing storage l = listings[listingId];
        if (block.timestamp >= l.endTime) return l.endPrice;
        uint256 elapsed = block.timestamp - l.startTime;
        uint256 duration = l.endTime - l.startTime;
        return l.startPrice - ((l.startPrice - l.endPrice) * elapsed) / duration;
    }

    /// @notice Buy a listing. Any ETH above the current price is credited back to the buyer,
    ///         which lets Dutch-auction buyers send a small buffer safely.
    function buy(uint256 listingId) external payable nonReentrant whenNotPaused {
        Listing storage l = listings[listingId];
        if (!l.active) revert ListingNotActive(listingId);

        address seller = l.seller;
        if (msg.sender == seller) revert SellerCannotBuy();

        uint256 price = priceOf(listingId);
        if (msg.value < price) revert InsufficientPayment(price, msg.value);

        IERC721 token = IERC721(l.nft);
        if (token.ownerOf(l.tokenId) != seller) revert ListingStale();

        // Effects before interactions.
        l.active = false;
        _settlePayment(l.nft, l.tokenId, seller, msg.sender, price);
        if (msg.value > price) credits[msg.sender] += msg.value - price;

        emit ListingSold(listingId, msg.sender, price);
        token.safeTransferFrom(seller, msg.sender, l.tokenId);
    }

    /// @notice Change the price of a fixed-price listing.
    function updatePrice(uint256 listingId, uint256 newPrice) external whenNotPaused {
        Listing storage l = _sellerListing(listingId);
        if (l.endTime != l.startTime) revert NotFixedPrice();
        if (newPrice == 0) revert ZeroPrice();
        l.startPrice = newPrice;
        l.endPrice = newPrice;
        emit ListingPriceUpdated(listingId, newPrice);
    }

    /// @notice Cancel a listing. Allowed while paused so sellers are never locked in.
    function cancelListing(uint256 listingId) external {
        Listing storage l = _sellerListing(listingId);
        l.active = false;
        emit ListingCancelled(listingId);
    }

    // =============================================================================================
    // Gasless signed orders (EIP-712)
    // =============================================================================================

    /// @notice EIP-712 digest a seller must sign for `order`.
    function hashOrder(Order calldata order) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ORDER_TYPEHASH,
                    order.seller,
                    order.nft,
                    order.tokenId,
                    order.price,
                    order.nonce,
                    order.deadline
                )
            )
        );
    }

    /// @notice Fill an order the seller signed off-chain. Supports EOA and ERC-1271 (smart wallet) signers.
    function fulfillOrder(Order calldata order, bytes calldata signature)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        if (block.timestamp > order.deadline) revert OrderExpired();
        if (order.price == 0) revert ZeroPrice();
        if (msg.value != order.price) revert IncorrectPayment(order.price, msg.value);
        if (msg.sender == order.seller) revert SellerCannotBuy();
        if (nonceUsed[order.seller][order.nonce]) revert NonceAlreadyUsed();

        bytes32 digest = hashOrder(order);
        if (!SignatureChecker.isValidSignatureNow(order.seller, digest, signature)) {
            revert InvalidSignature();
        }

        IERC721 token = IERC721(order.nft);
        if (token.ownerOf(order.tokenId) != order.seller) revert ListingStale();

        nonceUsed[order.seller][order.nonce] = true;
        _settlePayment(order.nft, order.tokenId, order.seller, msg.sender, order.price);

        emit OrderFilled(digest, order.seller, msg.sender, order.price);
        token.safeTransferFrom(order.seller, msg.sender, order.tokenId);
    }

    /// @notice Invalidate a signed order before anyone fills it.
    function cancelOrder(uint256 nonce) external {
        if (nonceUsed[msg.sender][nonce]) revert NonceAlreadyUsed();
        nonceUsed[msg.sender][nonce] = true;
        emit OrderCancelled(msg.sender, nonce);
    }

    // =============================================================================================
    // English auctions (NFT is escrowed by the marketplace)
    // =============================================================================================

    function createAuction(address nft, uint256 tokenId, uint256 reservePrice, uint64 duration)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 auctionId)
    {
        if (reservePrice == 0) revert ZeroPrice();
        if (duration < MIN_AUCTION_DURATION || duration > MAX_AUCTION_DURATION) revert InvalidDuration();
        _requireOwnerAndApproved(nft, tokenId, msg.sender);

        auctionId = ++auctionCount;
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 endTime = uint64(block.timestamp) + duration;
        auctions[auctionId] = Auction({
            seller: msg.sender,
            endTime: endTime,
            settled: false,
            nft: nft,
            highestBidder: address(0),
            tokenId: tokenId,
            reservePrice: reservePrice,
            highestBid: 0
        });

        emit AuctionCreated(auctionId, msg.sender, nft, tokenId, reservePrice, endTime);
        IERC721(nft).transferFrom(msg.sender, address(this), tokenId);
    }

    /// @notice Smallest bid that `bid()` would accept right now.
    function minNextBid(uint256 auctionId) public view returns (uint256) {
        Auction storage a = auctions[auctionId];
        if (a.highestBid == 0) return a.reservePrice;
        uint256 increment = (a.highestBid * MIN_BID_INCREMENT_BPS) / BPS;
        return a.highestBid + (increment == 0 ? 1 : increment);
    }

    /// @notice Place a bid. The previous highest bidder is refunded via `credits`.
    ///         Bids in the final 10 minutes push the end time out, so nobody can snipe the auction.
    function bid(uint256 auctionId) external payable nonReentrant whenNotPaused {
        Auction storage a = _existingAuction(auctionId);
        if (a.settled) revert AuctionAlreadySettled();
        if (block.timestamp >= a.endTime) revert AuctionHasEnded();
        if (msg.sender == a.seller) revert SellerCannotBuy();

        uint256 minBid = minNextBid(auctionId);
        if (msg.value < minBid) revert BidTooLow(minBid, msg.value);

        if (a.highestBidder != address(0)) credits[a.highestBidder] += a.highestBid;
        a.highestBidder = msg.sender;
        a.highestBid = msg.value;
        emit BidPlaced(auctionId, msg.sender, msg.value);

        if (a.endTime - block.timestamp < ANTI_SNIPE_WINDOW) {
            // forge-lint: disable-next-line(unsafe-typecast)
            a.endTime = uint64(block.timestamp) + ANTI_SNIPE_WINDOW;
            emit AuctionExtended(auctionId, a.endTime);
        }
    }

    /// @notice Finish an auction after it ends. Callable by anyone, including while paused.
    function settleAuction(uint256 auctionId) external nonReentrant {
        Auction storage a = _existingAuction(auctionId);
        if (a.settled) revert AuctionAlreadySettled();
        if (block.timestamp < a.endTime) revert AuctionNotEnded();

        a.settled = true;
        address winner = a.highestBidder;

        if (winner == address(0)) {
            emit AuctionSettled(auctionId, address(0), 0);
            IERC721(a.nft).transferFrom(address(this), a.seller, a.tokenId);
            return;
        }

        _settlePayment(a.nft, a.tokenId, a.seller, winner, a.highestBid);
        emit AuctionSettled(auctionId, winner, a.highestBid);
        // transferFrom (not safeTransferFrom): a winner contract that can't receive NFTs must not
        // be able to block the seller from getting paid.
        IERC721(a.nft).transferFrom(address(this), winner, a.tokenId);
    }

    /// @notice Seller can cancel an auction that has no bids yet.
    function cancelAuction(uint256 auctionId) external nonReentrant {
        Auction storage a = _existingAuction(auctionId);
        if (msg.sender != a.seller) revert NotSeller();
        if (a.settled) revert AuctionAlreadySettled();
        if (a.highestBidder != address(0)) revert AuctionHasBids();

        a.settled = true;
        emit AuctionCancelled(auctionId);
        IERC721(a.nft).transferFrom(address(this), a.seller, a.tokenId);
    }

    // =============================================================================================
    // Payouts
    // =============================================================================================

    /// @notice Withdraw all ETH credited to the caller.
    function withdraw() external nonReentrant {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credits[msg.sender] = 0;
        emit Withdrawal(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice How a sale of `price` would be split: (royalty receiver, royalty, protocol fee, seller net).
    function quoteSale(address nft, uint256 tokenId, uint256 price)
        public
        view
        returns (address royaltyReceiver, uint256 royalty, uint256 fee, uint256 sellerProceeds)
    {
        (royaltyReceiver, royalty) = _royaltyInfo(nft, tokenId, price);
        fee = (price * feeBps) / BPS;
        sellerProceeds = price - royalty - fee;
    }

    // =============================================================================================
    // Admin
    // =============================================================================================

    function setFee(uint256 newFeeBps) external onlyOwner {
        _setFee(newFeeBps);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        _setFeeRecipient(newRecipient);
    }

    /// @notice Emergency stop for new listings, purchases and bids. Cancels, settlements and
    ///         withdrawals keep working so users can always exit.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // =============================================================================================
    // Internal
    // =============================================================================================

    function _createListing(
        address nft,
        uint256 tokenId,
        uint256 startPrice,
        uint256 endPrice,
        uint64 duration
    ) internal returns (uint256 listingId) {
        _requireOwnerAndApproved(nft, tokenId, msg.sender);

        listingId = ++listingCount;
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 start = uint64(block.timestamp);
        uint64 end = start + duration;
        listings[listingId] = Listing({
            seller: msg.sender,
            startTime: start,
            active: true,
            nft: nft,
            endTime: end,
            tokenId: tokenId,
            startPrice: startPrice,
            endPrice: endPrice
        });
        emit Listed(listingId, msg.sender, nft, tokenId, startPrice, endPrice, end);
    }

    function _settlePayment(address nft, uint256 tokenId, address seller, address buyer, uint256 price)
        internal
    {
        (address royaltyReceiver, uint256 royalty, uint256 fee, uint256 sellerProceeds) =
            quoteSale(nft, tokenId, price);

        if (royalty > 0) credits[royaltyReceiver] += royalty;
        if (fee > 0) credits[feeRecipient] += fee;
        credits[seller] += sellerProceeds;

        emit Sale(nft, tokenId, seller, buyer, price, royaltyReceiver, royalty, fee);
    }

    /// @dev Reads ERC-2981 defensively: collections that don't implement it, revert, or ask for
    ///      more than MAX_ROYALTY_BPS can never break or drain a sale.
    function _royaltyInfo(address nft, uint256 tokenId, uint256 price)
        internal
        view
        returns (address receiver, uint256 amount)
    {
        if (!nft.supportsInterface(type(IERC2981).interfaceId)) return (address(0), 0);
        try IERC2981(nft).royaltyInfo(tokenId, price) returns (address r, uint256 a) {
            if (r == address(0) || a == 0) return (address(0), 0);
            uint256 cap = (price * MAX_ROYALTY_BPS) / BPS;
            return (r, a > cap ? cap : a);
        } catch {
            return (address(0), 0);
        }
    }

    function _requireOwnerAndApproved(address nft, uint256 tokenId, address owner) internal view {
        IERC721 token = IERC721(nft);
        if (token.ownerOf(tokenId) != owner) revert NotTokenOwner();
        if (token.getApproved(tokenId) != address(this) && !token.isApprovedForAll(owner, address(this))) {
            revert MarketplaceNotApproved();
        }
    }

    function _sellerListing(uint256 listingId) internal view returns (Listing storage l) {
        l = listings[listingId];
        if (!l.active) revert ListingNotActive(listingId);
        if (l.seller != msg.sender) revert NotSeller();
    }

    function _existingAuction(uint256 auctionId) internal view returns (Auction storage a) {
        a = auctions[auctionId];
        if (a.seller == address(0)) revert AuctionNotFound(auctionId);
    }

    function _setFee(uint256 newFeeBps) internal {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh(newFeeBps);
        feeBps = newFeeBps;
        emit FeeUpdated(newFeeBps);
    }

    function _setFeeRecipient(address newRecipient) internal {
        if (newRecipient == address(0)) revert ZeroAddress();
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(newRecipient);
    }
}
