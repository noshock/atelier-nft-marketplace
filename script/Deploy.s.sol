// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {CreatorNFT} from "../src/CreatorNFT.sol";
import {Marketplace} from "../src/Marketplace.sol";

/// @notice Deploys CreatorNFT + Marketplace and writes the addresses to frontend/deployments/<chainId>.json.
///
/// Local:   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
///          (uses Anvil's first dev key and seeds demo artwork, listings and auctions)
/// Sepolia: forge script script/Deploy.s.sol --rpc-url sepolia --account <keystore-name> --broadcast
///          (signs with an encrypted Foundry keystore; seeds demo data at testnet-friendly prices)
contract Deploy is Script {
    using Strings for uint256;

    // Anvil's default account #0 — a well-known public dev key, never use it on a real network.
    uint256 internal constant ANVIL_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    bool internal isLocal;

    function run() external {
        isLocal = block.chainid == 31337;
        bool seed = vm.envOr("SEED", true);
        uint256 feeBps = vm.envOr("FEE_BPS", uint256(250));

        address deployer;
        if (isLocal) {
            uint256 key = vm.envOr("PRIVATE_KEY", ANVIL_KEY);
            deployer = vm.addr(key);
            vm.startBroadcast(key);
        } else {
            // Signer comes from --account (encrypted keystore) or --ledger; no raw keys in env vars.
            deployer = msg.sender;
            vm.startBroadcast();
        }
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);

        CreatorNFT nft = new CreatorNFT();
        Marketplace market = new Marketplace(feeRecipient, feeBps);
        if (seed) _seed(nft, market);
        vm.stopBroadcast();

        console2.log("CreatorNFT  ", address(nft));
        console2.log("Marketplace ", address(market));

        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeUint(obj, "startBlock", block.number);
        vm.serializeAddress(obj, "nft", address(nft));
        string memory json = vm.serializeAddress(obj, "marketplace", address(market));
        vm.writeJson(json, string.concat("./frontend/deployments/", block.chainid.toString(), ".json"));
    }

    function _seed(CreatorNFT nft, Marketplace market) internal {
        nft.setApprovalForAll(address(market), true);

        string[6] memory titles =
            ["Field Notes I", "Quiet Hours", "Tidewater", "Ochre Study", "Night Garden", "Meridian"];
        string[6] memory palettes = [
            "#E8E1D3,#1F3B2C,#C8553D",
            "#F2EEE6,#22313F,#D9A441",
            "#DDE3E1,#1C4E5A,#E07A5F",
            "#EFE6D8,#7A4A1E,#2E2A24",
            "#1E2421,#C9D6C3,#B5523B",
            "#F4F1EA,#3A3F58,#8FA88B"
        ];

        uint256[6] memory ids;
        for (uint256 i; i < 6; ++i) {
            ids[i] = nft.mint(_tokenURI(titles[i], palettes[i], i), uint96(250 + i * 100));
        }

        // Testnet visitors pay with faucet ETH, so public demos use prices 100x lower and longer timers.
        uint256 u = isLocal ? 1 ether : 0.01 ether;
        market.list(address(nft), ids[0], (u * 8) / 100);
        market.list(address(nft), ids[1], (u * 25) / 100);
        market.listDutch(address(nft), ids[2], u, (u * 20) / 100, isLocal ? 6 hours : 3 days);
        market.createAuction(address(nft), ids[3], (u * 10) / 100, isLocal ? 1 days : 7 days);
        market.createAuction(address(nft), ids[4], (u * 30) / 100, isLocal ? 2 days : 14 days);
        // ids[5] stays unlisted in the deployer's collection.
    }

    function _tokenURI(string memory title, string memory palette, uint256 variant)
        internal
        pure
        returns (string memory)
    {
        string memory svg = _artwork(palette, variant);
        string memory json = string.concat(
            '{"name":"',
            title,
            '","description":"Seeded demo work from the Atelier Collective.","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg)),
            '"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// Small geometric compositions; palette = "background,ink,accent".
    function _artwork(string memory palette, uint256 v) internal pure returns (string memory) {
        string[3] memory c = _split(palette);
        string memory shapes;
        if (v % 3 == 0) {
            shapes = string.concat(
                '<circle cx="230" cy="170" r="110" fill="',
                c[2],
                '"/>',
                '<rect x="60" y="250" width="280" height="90" fill="',
                c[1],
                '"/>'
            );
        } else if (v % 3 == 1) {
            shapes = string.concat(
                '<rect x="70" y="70" width="160" height="260" fill="',
                c[1],
                '"/>',
                '<circle cx="250" cy="250" r="80" fill="',
                c[2],
                '"/>'
            );
        } else {
            shapes = string.concat(
                '<path d="M40 330 L200 70 L360 330 Z" fill="',
                c[1],
                '"/>',
                '<rect x="150" y="210" width="200" height="40" fill="',
                c[2],
                '"/>'
            );
        }
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="',
            c[0],
            '"/>',
            shapes,
            "</svg>"
        );
    }

    function _split(string memory s) internal pure returns (string[3] memory out) {
        bytes memory b = bytes(s);
        uint256 part;
        uint256 start;
        for (uint256 i; i <= b.length; ++i) {
            if (i == b.length || b[i] == ",") {
                bytes memory chunk = new bytes(i - start);
                for (uint256 j; j < chunk.length; ++j) {
                    chunk[j] = b[start + j];
                }
                out[part++] = string(chunk);
                start = i + 1;
            }
        }
    }
}
