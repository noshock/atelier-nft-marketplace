import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm";
import { CHAIN_ID, NETWORK, NFT_ABI, MARKET_ABI, ERROR_MESSAGES } from "./config.js";

export { ethers };

const listeners = new Set();
export const wallet = { account: null, chainId: null, signer: null };

export const readProvider = new ethers.JsonRpcProvider(NETWORK.rpc, CHAIN_ID, { staticNetwork: true });
export let deployment = null;
export let nft = null;
export let market = null;

/** Load addresses written by the deploy script. Returns false if nothing is deployed. */
export async function loadDeployment() {
  try {
    const res = await fetch(`./deployments/${CHAIN_ID}.json`, { cache: "no-store" });
    if (!res.ok) return false;
    deployment = await res.json();
    nft = new ethers.Contract(deployment.nft, NFT_ABI, readProvider);
    market = new ethers.Contract(deployment.marketplace, MARKET_ABI, readProvider);
    const code = await readProvider.getCode(deployment.marketplace);
    return code !== "0x";
  } catch {
    return false;
  }
}

export function onWalletChange(fn) {
  listeners.add(fn);
}

function emit() {
  listeners.forEach((fn) => fn(wallet));
}

export const hasInjectedWallet = () => typeof window.ethereum !== "undefined";
export const isWrongNetwork = () => wallet.account && wallet.chainId !== CHAIN_ID;

async function syncWallet(accounts) {
  wallet.account = accounts?.[0] ? ethers.getAddress(accounts[0]) : null;
  wallet.chainId = Number(await window.ethereum.request({ method: "eth_chainId" }));
  const provider = new ethers.BrowserProvider(window.ethereum);
  provider.pollingInterval = 1000; // confirm transactions within ~1s instead of the 4s default
  wallet.signer = wallet.account ? await provider.getSigner() : null;
  emit();
}

export async function initWallet() {
  if (!hasInjectedWallet()) return;
  window.ethereum.on?.("accountsChanged", syncWallet);
  window.ethereum.on?.("chainChanged", () => syncWallet([wallet.account].filter(Boolean)));
  const accounts = await window.ethereum.request({ method: "eth_accounts" });
  await syncWallet(accounts);
}

export async function connect() {
  if (!hasInjectedWallet()) throw new Error("NO_WALLET");
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  await syncWallet(accounts);
  if (isWrongNetwork()) await switchNetwork();
}

export async function switchNetwork() {
  const hex = "0x" + CHAIN_ID.toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (err) {
    if (err.code !== 4902) throw err;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: hex,
        chainName: NETWORK.name,
        rpcUrls: [NETWORK.rpc],
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        blockExplorerUrls: NETWORK.explorer ? [NETWORK.explorer] : undefined,
      }],
    });
  }
}

/** Contracts bound to the connected signer. */
export function writable() {
  if (!wallet.signer) throw new Error("NOT_CONNECTED");
  return { nft: nft.connect(wallet.signer), market: market.connect(wallet.signer) };
}

/** Seconds since epoch according to the chain (local chains can drift from wall-clock time). */
let clockOffset = 0;
export async function syncClock() {
  const block = await readProvider.getBlock("latest");
  clockOffset = Number(block.timestamp) - Math.floor(Date.now() / 1000);
  // A local chain that has been idle reports an old timestamp; never let the UI run behind wall time.
  if (clockOffset < 0) clockOffset = 0;
}
export const chainNow = () => Math.floor(Date.now() / 1000) + clockOffset;

/** Turn any wallet/RPC/contract error into a sentence a person can act on. */
export function explainError(err) {
  if (err?.message === "NO_WALLET") return "No wallet found. Install MetaMask or another browser wallet.";
  if (err?.message === "NOT_CONNECTED") return "Connect your wallet first.";
  if (err?.code === "ACTION_REJECTED" || err?.info?.error?.code === 4001 || err?.code === 4001) {
    return "You rejected the request in your wallet.";
  }
  const name = err?.revert?.name ?? decodeName(err);
  if (name && ERROR_MESSAGES[name]) return ERROR_MESSAGES[name];
  if (err?.code === "INSUFFICIENT_FUNDS") return "Your wallet doesn't have enough ETH for this transaction.";
  return err?.shortMessage ?? err?.message ?? "Something went wrong.";
}

const errorIface = new ethers.Interface([...MARKET_ABI, ...NFT_ABI].filter((f) => f.startsWith("error")));
function decodeName(err) {
  const data = err?.data ?? err?.info?.error?.data?.data ?? err?.info?.error?.data;
  if (typeof data !== "string" || data.length < 10) return null;
  try {
    return errorIface.parseError(data)?.name ?? null;
  } catch {
    return null;
  }
}

export function txUrl(hash) {
  return NETWORK.explorer ? `${NETWORK.explorer}/tx/${hash}` : null;
}

export function addressUrl(addr) {
  return NETWORK.explorer ? `${NETWORK.explorer}/address/${addr}` : null;
}
