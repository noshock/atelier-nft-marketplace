// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";

/// @title CreatorNFT
/// @notice Open-edition ERC-721 collection where every minter becomes the royalty receiver
///         (ERC-2981) of their own token. Royalties are capped so a creator can't set
///         an unreasonable cut on secondary sales.
contract CreatorNFT is ERC721URIStorage, ERC2981 {
    /// @notice Hard cap on per-token royalties: 10%.
    uint96 public constant MAX_ROYALTY_BPS = 1_000;

    uint256 private _nextTokenId;

    event Minted(uint256 indexed tokenId, address indexed creator, uint96 royaltyBps, string tokenURI);

    error RoyaltyTooHigh(uint96 royaltyBps, uint96 maxBps);
    error EmptyTokenURI();

    constructor() ERC721("Atelier Collective", "ATLR") {}

    /// @notice Mint a new token to the caller, who also receives its royalties.
    /// @param uri Token metadata URI (ipfs://, https:// or an on-chain data: URI).
    /// @param royaltyBps Royalty in basis points (100 = 1%), max 1_000.
    function mint(string calldata uri, uint96 royaltyBps) external returns (uint256 tokenId) {
        if (bytes(uri).length == 0) revert EmptyTokenURI();
        if (royaltyBps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh(royaltyBps, MAX_ROYALTY_BPS);

        tokenId = ++_nextTokenId;
        // Configure the token fully before _safeMint hands control to the receiver hook,
        // so a re-entering receiver never observes a token without its URI or royalty.
        _setTokenURI(tokenId, uri);
        _setTokenRoyalty(tokenId, msg.sender, royaltyBps);
        emit Minted(tokenId, msg.sender, royaltyBps, uri);

        _safeMint(msg.sender, tokenId);
    }

    /// @notice Number of tokens minted so far (token ids run from 1 to totalMinted()).
    function totalMinted() external view returns (uint256) {
        return _nextTokenId;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage, ERC2981)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
