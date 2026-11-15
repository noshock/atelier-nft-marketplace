import { ethers, txUrl, explainError } from "./chain.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/** 1234500000000000000n -> "1.2345" (max 4 decimals, no trailing zeros). */
export function eth(wei, decimals = 4) {
  const s = ethers.formatEther(wei ?? 0n);
  const [int, frac = ""] = s.split(".");
  const trimmed = frac.slice(0, decimals).replace(/0+$/, "");
  if (!trimmed && wei > 0n && int === "0") return "<0.0001";
  return trimmed ? `${int}.${trimmed}` : int;
}

export const short = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "");

/** Two-tone disc derived from an address, so people are recognisable at a glance. */
export function avatar(addr, size = 20) {
  const h = parseInt(addr.slice(2, 8), 16);
  const a = h % 360, b = (a + 40 + (h >> 8) % 120) % 360;
  return `<span class="avatar" style="width:${size}px;height:${size}px;background:linear-gradient(135deg,hsl(${a} 32% 58%) 0 50%,hsl(${b} 28% 34%) 50% 100%)" aria-hidden="true"></span>`;
}

export function countdown(secondsLeft) {
  if (secondsLeft <= 0) return "Ended";
  const d = Math.floor(secondsLeft / 86400);
  const h = Math.floor((secondsLeft % 86400) / 3600);
  const m = Math.floor((secondsLeft % 3600) / 60);
  const s = secondsLeft % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${String(s).padStart(2, "0")}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

// ---------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------

const ICONS = {
  pending: `<span class="spinner" aria-hidden="true"></span>`,
  success: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  error: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  info: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v4M8 4.6v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
};

export function toast(kind, title, body = "", { sticky = false } = {}) {
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  const set = (k, t, b = "") => {
    el.className = `toast toast--${k}`;
    el.innerHTML = `<div class="toast__icon">${ICONS[k]}</div><div class="toast__text"><strong>${esc(t)}</strong>${b ? `<span>${b}</span>` : ""}</div><button class="toast__close" aria-label="Dismiss">×</button>`;
    el.querySelector(".toast__close").onclick = () => remove();
  };
  const remove = () => {
    el.classList.add("toast--leaving");
    setTimeout(() => el.remove(), 200);
  };
  set(kind, title, body);
  $("#toasts").append(el);
  if (!sticky) setTimeout(remove, 6000);
  return { update: set, remove, close: (ms = 5000) => setTimeout(remove, ms) };
}

/**
 * Run a transaction with consistent feedback:
 * wallet prompt -> submitted -> confirmed / failed. Returns the receipt or null.
 */
export async function runTx(label, send) {
  const t = toast("pending", label, "Confirm in your wallet", { sticky: true });
  try {
    const tx = await send();
    const link = txUrl(tx.hash);
    t.update("pending", label, link ? `Submitted · <a href="${link}" target="_blank" rel="noopener">View transaction</a>` : "Submitted, waiting for confirmation");
    const receipt = await tx.wait();
    t.update("success", label, "Confirmed");
    t.close();
    return receipt;
  } catch (err) {
    console.error(err);
    t.update("error", `${label} failed`, esc(explainError(err)));
    t.close(8000);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------------------------

export function openModal(html, { wide = false } = {}) {
  const dialog = $("#modal");
  dialog.className = wide ? "modal modal--wide" : "modal";
  dialog.innerHTML = `<button class="modal__close" aria-label="Close" data-close>×</button>${html}`;
  dialog.showModal();
  dialog.onclick = (e) => {
    if (e.target === dialog || e.target.closest("[data-close]")) closeModal();
  };
  return dialog;
}

export function closeModal() {
  const dialog = $("#modal");
  if (dialog.open) dialog.close();
}

export async function copy(text, what = "Link") {
  try {
    await navigator.clipboard.writeText(text);
    toast("success", `${what} copied`);
  } catch {
    toast("error", "Couldn't copy", "Select the text and copy it manually.");
  }
}
