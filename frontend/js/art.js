// Deterministic generative compositions, so creators can mint without hosting an image.
// The SVG is stored fully on-chain inside a data: URI.

const PALETTES = [
  ["#E8E1D3", "#1F3B2C", "#C8553D"],
  ["#F2EEE6", "#22313F", "#D9A441"],
  ["#DDE3E1", "#1C4E5A", "#E07A5F"],
  ["#EFE6D8", "#7A4A1E", "#2E2A24"],
  ["#1E2421", "#C9D6C3", "#B5523B"],
  ["#F4F1EA", "#3A3F58", "#8FA88B"],
  ["#E9E4DA", "#2B2B2B", "#4F7CAC"],
  ["#F1E9DC", "#5B2A2A", "#D8B26E"],
];

function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (n) => Math.round(n);

const LAYOUTS = [
  // Sun over horizon
  (r, [bg, ink, acc]) => {
    const cx = 120 + r() * 160, cy = 110 + r() * 80, rad = 60 + r() * 70, h = 230 + r() * 60;
    return `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(rad)}" fill="${acc}"/>` +
      `<rect x="0" y="${round(h)}" width="400" height="${round(400 - h)}" fill="${ink}"/>`;
  },
  // Offset blocks
  (r, [bg, ink, acc]) => {
    const w = 120 + r() * 80, x = 50 + r() * 60;
    return `<rect x="${round(x)}" y="60" width="${round(w)}" height="280" fill="${ink}"/>` +
      `<circle cx="${round(x + w)}" cy="${round(150 + r() * 120)}" r="${round(50 + r() * 50)}" fill="${acc}"/>`;
  },
  // Stripes
  (r, [bg, ink, acc]) => {
    const n = 4 + Math.floor(r() * 4), gap = 300 / n;
    let s = "";
    for (let i = 0; i < n; i++) {
      const w = 40 + r() * 220;
      s += `<rect x="50" y="${round(50 + i * gap)}" width="${round(w)}" height="${round(gap * 0.55)}" fill="${i % 3 === 1 ? acc : ink}"/>`;
    }
    return s;
  },
  // Arches
  (r, [bg, ink, acc]) => {
    const n = 2 + Math.floor(r() * 3);
    let s = "";
    for (let i = 0; i < n; i++) {
      const w = 260 - i * (200 / n), x = 200 - w / 2;
      s += `<path d="M${round(x)} 340 V${round(200 - w / 4)} A${round(w / 2)} ${round(w / 2)} 0 0 1 ${round(x + w)} ${round(200 - w / 4)} V340 Z" fill="${i % 2 ? bg : i === n - 1 ? acc : ink}"/>`;
    }
    return s;
  },
  // Grid of dots
  (r, [bg, ink, acc]) => {
    const n = 4 + Math.floor(r() * 3), step = 280 / (n - 1), hot = Math.floor(r() * n * n);
    let s = "";
    for (let i = 0; i < n * n; i++) {
      const x = 60 + (i % n) * step, y = 60 + Math.floor(i / n) * step;
      s += `<circle cx="${round(x)}" cy="${round(y)}" r="${round(step * (i === hot ? 0.42 : 0.18))}" fill="${i === hot ? acc : ink}"/>`;
    }
    return s;
  },
];

export function generateArtwork(seed) {
  const r = rng(seed);
  const palette = PALETTES[Math.floor(r() * PALETTES.length)];
  const layout = LAYOUTS[Math.floor(r() * LAYOUTS.length)];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="${palette[0]}"/>${layout(r, palette)}</svg>`;
}

export const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export const svgDataUri = (svg) => `data:image/svg+xml;base64,${toBase64(svg)}`;

export function buildTokenUri({ name, description, image }) {
  const json = JSON.stringify({ name, description, image });
  return `data:application/json;base64,${toBase64(json)}`;
}

const ipfs = (uri) => (uri?.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${uri.slice(7)}` : uri);

/** Resolve a tokenURI (data:, ipfs:// or https://) to { name, description, image }. */
export async function resolveMetadata(uri, tokenId) {
  const fallback = { name: `Untitled #${tokenId}`, description: "", image: null };
  try {
    let meta;
    if (uri.startsWith("data:application/json;base64,")) {
      meta = JSON.parse(fromBase64(uri.split(",")[1]));
    } else if (uri.startsWith("data:application/json")) {
      meta = JSON.parse(decodeURIComponent(uri.slice(uri.indexOf(",") + 1)));
    } else {
      const res = await fetch(ipfs(uri));
      meta = await res.json();
    }
    return { ...fallback, ...meta, image: ipfs(meta.image) ?? null };
  } catch {
    return fallback;
  }
}

export function base64UrlEncode(obj) {
  return toBase64(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(fromBase64(b64 + "===".slice((b64.length + 3) % 4)));
}
