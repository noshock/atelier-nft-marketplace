import {
  ethers, wallet, readProvider, loadDeployment, deployment, nft, market, initWallet, connect,
  switchNetwork, onWalletChange, hasInjectedWallet, isWrongNetwork, writable, syncClock, chainNow,
  explainError, addressUrl,
} from "./chain.js";
import { $, $$, esc, eth, short, avatar, countdown, toast, runTx, openModal, closeModal, copy } from "./ui.js";
import {
  generateArtwork, randomSeed, svgDataUri, buildTokenUri, resolveMetadata, base64UrlEncode, base64UrlDecode,
} from "./art.js";
import { CHAIN_ID, NETWORK } from "./config.js";

// =================================================================================================
// State
// =================================================================================================

const state = {
  loaded: false,
  tokens: new Map(), // id -> { id, owner, creator, royaltyBps, meta }
  listings: [],
  auctions: [],
  sales: [],
  feeBps: 0n,
  credits: 0n,
  filter: "all",
  sort: "new",
  profileTab: "collected",
};
const metaCache = new Map();

const range = (from, to) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
const isMe = (addr) => same(addr, wallet.account);
const marketAddr = () => deployment.marketplace;

async function loadToken(id) {
  const [owner, [creator, royalty]] = await Promise.all([nft.ownerOf(id), nft.royaltyInfo(id, 10_000n)]);
  if (!metaCache.has(id)) metaCache.set(id, resolveMetadata(await nft.tokenURI(id), id));
  return { id, owner, creator, royaltyBps: Number(royalty), meta: await metaCache.get(id) };
}

async function loadAll() {
  await syncClock();
  const [minted, listingCount, auctionCount, feeBps] = await Promise.all([
    nft.totalMinted(), market.listingCount(), market.auctionCount(), market.feeBps(),
  ]);
  state.feeBps = feeBps;

  const [tokens, rawListings, rawAuctions, sales] = await Promise.all([
    Promise.all(range(1, Number(minted)).map(loadToken)),
    Promise.all(range(1, Number(listingCount)).map(async (id) => ({ id, ...plainListing(await market.listings(id)) }))),
    Promise.all(range(1, Number(auctionCount)).map(async (id) => ({ id, ...plainAuction(await market.auctions(id)) }))),
    // Public RPCs cap log-range queries; volume is nice-to-have, so never let it break the page.
    market.queryFilter(market.filters.Sale(), deployment.startBlock ?? 0).catch(() => []),
  ]);

  state.tokens = new Map(tokens.map((t) => [t.id, t]));

  // A listing is only buyable if the seller still owns the piece and the marketplace is still approved.
  const approvals = new Map();
  const approved = (seller) => {
    if (!approvals.has(seller)) approvals.set(seller, nft.isApprovedForAll(seller, marketAddr()));
    return approvals.get(seller);
  };
  const active = rawListings.filter((l) => l.active && same(l.nft, deployment.nft));
  await Promise.all(active.map(async (l) => {
    l.valid = same(state.tokens.get(l.tokenId)?.owner, l.seller) && (await approved(l.seller));
  }));
  state.listings = active.filter((l) => l.valid);
  state.auctions = rawAuctions.filter((a) => same(a.nft, deployment.nft));
  state.sales = sales.map((e) => ({ tokenId: Number(e.args.tokenId), price: e.args.price, buyer: e.args.buyer, seller: e.args.seller, block: e.blockNumber }));
  state.credits = wallet.account ? await market.credits(wallet.account) : 0n;
  state.loaded = true;
  renderChrome();
}

function plainListing(l) {
  return {
    seller: l.seller, active: l.active, nft: l.nft, tokenId: Number(l.tokenId),
    startTime: Number(l.startTime), endTime: Number(l.endTime), startPrice: l.startPrice, endPrice: l.endPrice,
    dutch: l.endTime !== l.startTime,
  };
}

function plainAuction(a) {
  return {
    seller: a.seller, endTime: Number(a.endTime), settled: a.settled, nft: a.nft, tokenId: Number(a.tokenId),
    highestBidder: a.highestBidder === ethers.ZeroAddress ? null : a.highestBidder,
    reservePrice: a.reservePrice, highestBid: a.highestBid,
  };
}

/** What is happening with a token on the market right now. */
function marketOf(tokenId) {
  const auction = state.auctions.find((a) => a.tokenId === tokenId && !a.settled);
  if (auction) return { kind: "auction", auction, ended: chainNow() >= auction.endTime };
  const listing = state.listings.filter((l) => l.tokenId === tokenId).at(-1);
  if (listing) return { kind: listing.dutch ? "dutch" : "fixed", listing };
  return { kind: "none" };
}

function dutchPrice(l, now = chainNow()) {
  if (now >= l.endTime) return l.endPrice;
  const elapsed = BigInt(Math.max(0, now - l.startTime));
  return l.startPrice - ((l.startPrice - l.endPrice) * elapsed) / BigInt(l.endTime - l.startTime);
}

const askPrice = (m) =>
  m.kind === "fixed" ? m.listing.endPrice
  : m.kind === "dutch" ? dutchPrice(m.listing)
  : m.kind === "auction" ? (m.auction.highestBid || m.auction.reservePrice)
  : null;

/** The effective holder: a piece escrowed in an auction still "belongs" to its seller. */
function holderOf(t) {
  const m = marketOf(t.id);
  return m.kind === "auction" ? m.auction.seller : t.owner;
}

const safeImage = (url) => (typeof url === "string" && /^(https?:\/\/|data:image\/)/i.test(url) ? url : null);

function media(t, cls = "") {
  const src = safeImage(t?.meta?.image);
  return src
    ? `<img class="${cls}" src="${esc(src)}" alt="${esc(t.meta.name)}" loading="lazy" decoding="async" />`
    : `<div class="${cls} skeleton" style="width:100%;height:100%;border-radius:0"></div>`;
}

const personLink = (addr) =>
  `<a href="#/profile/${addr}">${isMe(addr) ? "You" : short(addr)}</a>`;

// =================================================================================================
// Rendering helpers
// =================================================================================================

function card(t) {
  const m = marketOf(t.id);
  let tag = "", foot;
  if (m.kind === "fixed") {
    foot = `<span class="k">Price</span><span class="v">${eth(m.listing.endPrice)} ETH</span>`;
  } else if (m.kind === "dutch") {
    tag = `<span class="card__tag">Price dropping</span>`;
    foot = `<span class="k">Now</span><span class="v"><span data-dutch="${m.listing.id}">${eth(dutchPrice(m.listing))}</span> ETH</span>`;
  } else if (m.kind === "auction") {
    const a = m.auction;
    tag = m.ended ? `<span class="card__tag">Auction ended</span>` : `<span class="card__tag card__tag--live">Live auction</span>`;
    foot = `<span class="k">${a.highestBidder ? "Top bid" : "Reserve"} <span class="v">${eth(a.highestBid || a.reservePrice)} ETH</span></span>`
      + `<span class="k mono" data-ends="${a.endTime}">${countdown(a.endTime - chainNow())}</span>`;
  } else {
    foot = `<span class="k">Not for sale</span><span class="k">${isMe(t.owner) ? "Yours" : short(t.owner)}</span>`;
  }
  return `
    <a class="card" href="#/item/${t.id}">
      <div class="card__media">${media(t)}${tag}</div>
      <div class="card__body">
        <h3 class="card__title">${esc(t.meta.name)}</h3>
        <div class="card__by">${avatar(t.creator, 16)} ${isMe(t.creator) ? "You" : short(t.creator)}</div>
        <div class="card__foot">${foot}</div>
      </div>
    </a>`;
}

const skeletonGrid = (n = 8) =>
  `<div class="grid">${Array.from({ length: n }, () => `
    <div><div class="card__media skeleton"></div>
      <div class="skeleton" style="height:18px;width:70%;margin-top:14px"></div>
      <div class="skeleton" style="height:13px;width:40%;margin-top:8px"></div></div>`).join("")}</div>`;

function empty(title, body, action = "") {
  return `<div class="empty"><h3>${title}</h3><p>${body}</p>${action}</div>`;
}

const INFO_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 7v4M8 4.8v.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const note = (text) => `<p class="note">${INFO_ICON}<span>${text}</span></p>`;

function breakdown(price, t, sellerIsCreator, label = "You receive") {
  const fee = (price * state.feeBps) / 10_000n;
  const royaltyBps = BigInt(Math.min(t.royaltyBps, 1000));
  const royalty = (price * royaltyBps) / 10_000n;
  const net = price - fee - (sellerIsCreator ? 0n : royalty);
  return `
    <dl class="breakdown">
      <div><dt>Sale price</dt><dd>${eth(price)} ETH</dd></div>
      <div><dt>Creator royalty (${Number(royaltyBps) / 100}%)${sellerIsCreator ? " · paid to you" : ""}</dt><dd>${sellerIsCreator ? "" : "−"}${eth(royalty)} ETH</dd></div>
      <div><dt>Marketplace fee (${Number(state.feeBps) / 100}%)</dt><dd>−${eth(fee)} ETH</dd></div>
      <div class="total"><dt>${label}</dt><dd>${eth(net)} ETH</dd></div>
    </dl>`;
}

function parseEth(value) {
  try {
    const v = ethers.parseEther(String(value).trim() || "0");
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

async function requireWallet() {
  if (!wallet.account) {
    try {
      await connect();
    } catch (err) {
      toast("error", "Couldn't connect", esc(explainError(err)));
      return false;
    }
  }
  if (isWrongNetwork()) {
    try {
      await switchNetwork();
    } catch (err) {
      toast("error", "Wrong network", `Switch your wallet to ${esc(NETWORK.name)}.`);
      return false;
    }
  }
  return !!wallet.account;
}

async function refresh() {
  await loadAll();
  render({ keepScroll: true });
}

// =================================================================================================
// Views
// =================================================================================================

function renderSetup() {
  $("#main").innerHTML = `
    <div class="wrap setup">
      <p class="eyebrow">Setup</p>
      <h1 class="h2">No marketplace found on ${esc(NETWORK.name)}</h1>
      <p class="lede">The app couldn't reach the contracts. Start a local chain and deploy them, then reload this page.</p>
      <ol>
        <li>Start a local chain: <pre>anvil</pre></li>
        <li>Deploy and seed demo artwork: <pre>forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast</pre></li>
        <li>In your wallet, import an Anvil test account (for example account #1) and switch to network <code>31337</code>.</li>
      </ol>
      ${CHAIN_ID !== 31337 ? `<p class="hint">Looking for the local demo? <a href="?chain=31337">Switch to Anvil Local</a>.</p>` : ""}
      <button class="btn btn--primary" onclick="location.reload()">Reload</button>
    </div>`;
}

function renderExplore() {
  const tokens = [...state.tokens.values()];
  const live = state.auctions.filter((a) => !a.settled);
  const forSale = tokens.filter((t) => ["fixed", "dutch"].includes(marketOf(t.id).kind));
  const volume = state.sales.reduce((s, x) => s + x.price, 0n);
  const artists = new Set(tokens.map((t) => t.creator.toLowerCase())).size;

  let list = state.filter === "sale" ? forSale
    : state.filter === "auction" ? tokens.filter((t) => marketOf(t.id).kind === "auction")
    : tokens;

  const price = (t) => askPrice(marketOf(t.id));
  list = [...list].sort((a, b) => {
    if (state.sort === "new") return b.id - a.id;
    const pa = price(a), pb = price(b);
    if (pa === null) return 1;
    if (pb === null) return -1;
    return state.sort === "low" ? (pa < pb ? -1 : 1) : (pa > pb ? -1 : 1);
  });

  const chip = (id, label, count) =>
    `<button class="chip" data-filter="${id}" aria-pressed="${state.filter === id}">${label}<span class="count">${count}</span></button>`;

  $("#main").innerHTML = `
    <div class="wrap">
      <section class="page-head">
        <div>
          <p class="eyebrow">Atelier Collective</p>
          <h1 class="display">Collect work from <em>independent</em> artists.</h1>
          <p class="lede">Every sale pays the artist a royalty, forever. Buy at a fixed price, catch a falling price, or bid in a live auction.</p>
        </div>
        <a class="btn btn--secondary" href="#/create">Mint your own work</a>
      </section>

      <section class="stats" aria-label="Marketplace stats">
        <div class="stat"><div class="stat__value">${tokens.length}</div><div class="stat__label">Works minted</div></div>
        <div class="stat"><div class="stat__value">${forSale.length + live.length}</div><div class="stat__label">Available now</div></div>
        <div class="stat"><div class="stat__value">${artists}</div><div class="stat__label">Artists</div></div>
        <div class="stat"><div class="stat__value">${eth(volume, 2)} <span style="font-size:16px">ETH</span></div><div class="stat__label">Total volume</div></div>
      </section>

      <div class="toolbar">
        <div class="chips" role="group" aria-label="Filter">
          ${chip("all", "All works", tokens.length)}
          ${chip("sale", "Buy now", forSale.length)}
          ${chip("auction", "Auctions", live.length)}
        </div>
        <label>
          <select class="select" id="sort" aria-label="Sort">
            <option value="new" ${state.sort === "new" ? "selected" : ""}>Newest first</option>
            <option value="low" ${state.sort === "low" ? "selected" : ""}>Price: low to high</option>
            <option value="high" ${state.sort === "high" ? "selected" : ""}>Price: high to low</option>
          </select>
        </label>
      </div>

      <div class="grid">
        ${list.length ? list.map(card).join("") : empty(
          state.filter === "all" ? "Nothing here yet" : "Nothing matches this filter",
          state.filter === "all" ? "Be the first to mint a piece on Atelier." : "Try another filter, or check back soon.",
          `<a class="btn btn--primary btn--sm" href="#/create">Create a piece</a>`)}
      </div>
    </div>`;

  $$("[data-filter]").forEach((b) => (b.onclick = () => { state.filter = b.dataset.filter; renderExplore(); }));
  $("#sort").onchange = (e) => { state.sort = e.target.value; renderExplore(); };
}

function renderAuctions() {
  const now = chainNow();
  const live = state.auctions.filter((a) => !a.settled && a.endTime > now).sort((a, b) => a.endTime - b.endTime);
  const awaiting = state.auctions.filter((a) => !a.settled && a.endTime <= now);
  const past = state.auctions.filter((a) => a.settled && a.highestBidder).reverse().slice(0, 8);
  const tok = (a) => state.tokens.get(a.tokenId);

  const pastCard = (a) => {
    const t = tok(a);
    return `
      <a class="card" href="#/item/${t.id}">
        <div class="card__media">${media(t)}</div>
        <div class="card__body">
          <h3 class="card__title">${esc(t.meta.name)}</h3>
          <div class="card__foot"><span class="k">Sold for</span><span class="v">${eth(a.highestBid)} ETH</span></div>
        </div>
      </a>`;
  };

  $("#main").innerHTML = `
    <div class="wrap">
      <section class="page-head">
        <div>
          <p class="eyebrow">Timed auctions</p>
          <h1 class="display">Live auctions</h1>
          <p class="lede">Each bid must beat the last by 5%. A bid in the final 10 minutes adds time to the clock, so there's no last-second sniping.</p>
        </div>
      </section>
      <div class="grid">
        ${live.length ? live.map((a) => card(tok(a))).join("") : empty("No live auctions", "When an artist starts an auction, it will show up here.")}
      </div>
      ${awaiting.length ? `
        <h2 class="h2" style="margin:8px 0 6px">Ended, ready to settle</h2>
        <p class="muted" style="margin:0 0 22px">Anyone can settle an ended auction. It sends the piece to the winner and pays the seller.</p>
        <div class="grid">${awaiting.map((a) => card(tok(a))).join("")}</div>` : ""}
      ${past.length ? `
        <h2 class="h2" style="margin:8px 0 22px">Recently sold</h2>
        <div class="grid">${past.map(pastCard).join("")}</div>` : ""}
    </div>`;
}

// ------------------------------------------------------------------------------------------------- Item

let itemToken = null;

async function renderItem(id) {
  const t = state.tokens.get(Number(id));
  if (!t) {
    $("#main").innerHTML = `<div class="wrap" style="padding:72px 0">${empty("Piece not found", "It may not have been minted yet.", `<a class="btn btn--secondary btn--sm" href="#/">Back to explore</a>`)}</div>`;
    return;
  }
  itemToken = t;
  const m = marketOf(t.id);
  const holder = holderOf(t);

  $("#main").innerHTML = `
    <div class="wrap">
      <nav class="crumb"><a href="#/">← Explore</a></nav>
      <article class="item">
        <div class="item__media">${media(t)}</div>
        <div>
          <h1 class="item__title">${esc(t.meta.name)}</h1>
          <div class="people">
            <div class="person">${avatar(t.creator, 34)}<div><div class="person__k">Artist</div><div class="person__v">${personLink(t.creator)}</div></div></div>
            <div class="person">${avatar(holder, 34)}<div><div class="person__k">Owner</div><div class="person__v">${personLink(holder)}</div></div></div>
          </div>
          ${t.meta.description ? `<p class="desc">${esc(t.meta.description)}</p>` : ""}
          ${pricePanel(t, m)}
          <div class="facts">
            <div><div class="k">Creator royalty</div><div class="v">${t.royaltyBps / 100}%</div></div>
            <div><div class="k">Token ID</div><div class="v mono">#${t.id}</div></div>
            <div><div class="k">Standard</div><div class="v">ERC-721</div></div>
          </div>
          <section class="section">
            <h2 class="section__title">Activity</h2>
            <ul class="activity" id="activity"><li><span class="skeleton" style="height:14px;grid-column:1/-1"></span></li></ul>
          </section>
        </div>
      </article>
    </div>`;

  bindItemActions(t, m);
  loadActivity(t).catch(() => ($("#activity").innerHTML = `<li><span class="muted" style="grid-column:1/-1">Couldn't load activity.</span></li>`));
}

function pricePanel(t, m) {
  const mine = isMe(holderOf(t));
  const connectLabel = wallet.account ? null : "Connect wallet";

  if (m.kind === "fixed") {
    const l = m.listing;
    return `
      <div class="panel">
        <div class="panel__k"><span>Price</span><span class="badge">Fixed price</span></div>
        <div class="price">${eth(l.endPrice)} <small>ETH</small></div>
        <div class="panel__sub">Listed by ${isMe(l.seller) ? "you" : short(l.seller)}</div>
        <div class="panel__actions">
          ${mine ? `<div class="row"><button class="btn btn--secondary" data-act="edit">Edit price</button><button class="btn btn--danger" data-act="cancel-listing">Remove listing</button></div>`
            : `<button class="btn btn--primary btn--block" data-act="buy">${connectLabel ?? `Buy for ${eth(l.endPrice)} ETH`}</button>`}
        </div>
        ${mine ? breakdown(l.endPrice, t, same(l.seller, t.creator)) : note(`${t.royaltyBps / 100}% of the price goes to the artist.`)}
      </div>`;
  }

  if (m.kind === "dutch") {
    const l = m.listing;
    return `
      <div class="panel">
        <div class="panel__k"><span>Current price</span><span class="badge badge--accent">Price dropping</span></div>
        <div class="price"><span data-dutch="${l.id}">${eth(dutchPrice(l))}</span> <small>ETH</small></div>
        <div class="decay">
          <div class="decay__bar"><div class="decay__fill" data-decay="${l.id}" style="width:${decayPct(l)}%"></div></div>
          <div class="decay__labels"><span>${eth(l.startPrice)} ETH</span><span>floor ${eth(l.endPrice)} ETH</span></div>
        </div>
        <div class="panel__sub">${chainNow() >= l.endTime ? "The price has reached its floor." : `Reaches the floor in <span class="mono" data-ends="${l.endTime}">${countdown(l.endTime - chainNow())}</span>`}</div>
        <div class="panel__actions">
          ${mine ? `<button class="btn btn--danger" data-act="cancel-listing">Remove listing</button>`
            : `<button class="btn btn--primary btn--block" data-act="buy-dutch">${connectLabel ?? "Buy at current price"}</button>`}
        </div>
        ${mine ? "" : note("You pay the price at the moment your transaction confirms. Anything extra you send goes to your Atelier balance.")}
      </div>`;
  }

  if (m.kind === "auction") {
    const a = m.auction;
    const left = a.endTime - chainNow();
    const top = a.highestBidder;
    let actions;
    if (m.ended) {
      actions = `<button class="btn btn--primary btn--block" data-act="settle">${top ? "Settle auction" : "Return piece to seller"}</button>`;
    } else if (isMe(a.seller)) {
      actions = top ? `<p class="hint">Bidding has started, so this auction can't be cancelled.</p>`
        : `<button class="btn btn--danger" data-act="cancel-auction">Cancel auction</button>`;
    } else {
      actions = `
        <div class="field">
          <label class="label" for="bid-amount">Your bid <small>minimum ${eth(minBid(a))} ETH</small></label>
          <div class="input-group"><input class="input mono" id="bid-amount" inputmode="decimal" value="${ethers.formatEther(minBid(a))}" /><span class="input-group__suffix">ETH</span></div>
        </div>
        <button class="btn btn--primary btn--block" data-act="bid">${connectLabel ?? "Place bid"}</button>`;
    }
    return `
      <div class="panel">
        <div class="panel__k"><span>${top ? "Current bid" : "Reserve price"}</span>${m.ended ? `<span class="badge">Ended</span>` : `<span class="badge badge--accent">Live</span>`}</div>
        <div class="price">${eth(a.highestBid || a.reservePrice)} <small>ETH</small></div>
        <div class="panel__sub">${top ? `by ${isMe(top) ? "you" : short(top)}` : "No bids yet"}</div>
        <div class="timer">
          <div><div class="k">${m.ended ? "Ended" : "Ends in"}</div><div class="v" data-ends="${a.endTime}" data-rerender>${countdown(left)}</div></div>
          <div><div class="k">Closes</div><div class="v v--text">${new Date(a.endTime * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div></div>
        </div>
        <div class="panel__actions">${actions}</div>
        ${m.ended ? note(top ? "Settling sends the piece to the winner and pays the seller. Anyone can do it." : "No one bid. Settling returns the piece to the seller.")
          : isMe(a.seller) ? note("The marketplace holds your piece until the auction ends.")
          : note("If someone outbids you, your ETH is returned to your Atelier balance, ready to withdraw.")}
      </div>`;
  }

  // Not on the market
  if (mine) {
    return `
      <div class="panel">
        <div class="panel__k"><span>This piece is yours</span></div>
        <div class="panel__sub" style="margin-top:6px">Put it up for sale at a fixed price, a declining price, or as a timed auction.</div>
        <div class="panel__actions"><button class="btn btn--primary btn--block" data-act="sell">Sell this piece</button></div>
      </div>`;
  }
  return `
    <div class="panel">
      <div class="panel__k"><span>Not for sale</span></div>
      <div class="panel__sub" style="margin:6px 0 0">The owner hasn't listed this piece. ${t.royaltyBps ? `If it's resold, the artist earns ${t.royaltyBps / 100}%.` : ""}</div>
    </div>`;
}

const minBid = (a) => {
  if (!a.highestBid) return a.reservePrice;
  const inc = (a.highestBid * 500n) / 10_000n;
  return a.highestBid + (inc === 0n ? 1n : inc);
};

function decayPct(l) {
  const total = l.endTime - l.startTime;
  return Math.min(100, Math.max(0, ((chainNow() - l.startTime) / total) * 100)).toFixed(2);
}

function bindItemActions(t, m) {
  const on = (act, fn) => $$(`[data-act="${act}"]`).forEach((b) => (b.onclick = () => guard(b, fn)));

  on("sell", () => openSellModal(t));
  on("edit", () => openEditPrice(t, m.listing));
  on("cancel-listing", async () => {
    if (await runTx("Remove listing", () => writable().market.cancelListing(m.listing.id))) await refresh();
  });
  on("buy", async () => {
    if (!(await requireWallet())) return;
    if (isMe(m.listing.seller)) return render();
    if (await runTx(`Buy “${t.meta.name}”`, () => writable().market.buy(m.listing.id, { value: m.listing.endPrice }))) {
      await refresh();
      toast("success", "It's yours", `“${esc(t.meta.name)}” is now in your collection.`);
    }
  });
  on("buy-dutch", async () => {
    if (!(await requireWallet())) return;
    // Price only goes down, so the on-chain price right now is a safe ceiling. Add 1% headroom in
    // case the transaction lands a few seconds early on a drifting local clock; the excess is credited back.
    const current = await market.priceOf(m.listing.id);
    const value = current + current / 100n;
    if (await runTx(`Buy “${t.meta.name}”`, () => writable().market.buy(m.listing.id, { value }))) {
      await refresh();
      toast("success", "It's yours", `“${esc(t.meta.name)}” is now in your collection.`);
    }
  });
  on("bid", async () => {
    const input = $("#bid-amount");
    const value = parseEth(input.value);
    const min = minBid(m.auction);
    if (!value || value < min) {
      input.setAttribute("aria-invalid", "true");
      toast("error", "Bid too low", `The minimum bid is ${eth(min)} ETH.`);
      return;
    }
    if (!(await requireWallet())) return;
    if (await runTx(`Bid ${eth(value)} ETH`, () => writable().market.bid(m.auction.id, { value }))) {
      await refresh();
      toast("success", "You're the top bidder", "If someone outbids you, your ETH goes back to your balance.");
    }
  });
  on("settle", async () => {
    if (!(await requireWallet())) return;
    if (await runTx("Settle auction", () => writable().market.settleAuction(m.auction.id))) await refresh();
  });
  on("cancel-auction", async () => {
    if (await runTx("Cancel auction", () => writable().market.cancelAuction(m.auction.id))) await refresh();
  });
}

async function guard(button, fn) {
  if (button.disabled) return;
  const label = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span>`;
  try {
    await fn();
  } catch (err) {
    console.error(err);
    toast("error", "Something went wrong", esc(explainError(err)));
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.innerHTML = label;
    }
  }
}

const timeCache = new Map();
async function blockTime(n) {
  if (!timeCache.has(n)) timeCache.set(n, readProvider.getBlock(n).then((b) => Number(b.timestamp)));
  return timeCache.get(n);
}

function ago(ts) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

async function loadActivity(t) {
  const from = deployment.startBlock ?? 0;
  const auctionIds = state.auctions.filter((a) => a.tokenId === t.id).map((a) => a.id);
  const [mints, sales, listed, ...bidGroups] = await Promise.all([
    nft.queryFilter(nft.filters.Minted(t.id), from),
    market.queryFilter(market.filters.Sale(deployment.nft, t.id), from),
    market.queryFilter(market.filters.Listed(null, null, deployment.nft), from),
    ...auctionIds.map((id) => market.queryFilter(market.filters.BidPlaced(id), from)),
  ]);
  const rows = [
    ...mints.map((e) => ({ e, ev: "Minted", who: e.args.creator, amt: null })),
    ...listed.filter((e) => Number(e.args.tokenId) === t.id).map((e) => ({ e, ev: "Listed", who: e.args.seller, amt: e.args.startPrice })),
    ...bidGroups.flat().map((e) => ({ e, ev: "Bid", who: e.args.bidder, amt: e.args.amount })),
    ...sales.map((e) => ({ e, ev: "Sold", who: e.args.buyer, amt: e.args.price })),
  ];
  await Promise.all(rows.map(async (r) => (r.ts = await blockTime(r.e.blockNumber))));
  rows.sort((a, b) => b.e.blockNumber - a.e.blockNumber || b.e.index - a.e.index);

  const el = $("#activity");
  if (!el) return;
  el.innerHTML = rows.length
    ? rows.map((r) => `
        <li>
          <span class="ev">${r.ev}</span>
          <span class="who">${avatar(r.who, 18)} ${personLink(r.who)} · ${ago(r.ts)}</span>
          <span class="amt">${r.amt !== null ? `${eth(r.amt)} ETH` : ""}</span>
        </li>`).join("")
    : `<li><span class="muted" style="grid-column:1/-1">No activity yet.</span></li>`;
}

// ------------------------------------------------------------------------------------------------- Sell flow

const DURATIONS = [
  [3600, "1 hour"], [6 * 3600, "6 hours"], [86400, "1 day"], [3 * 86400, "3 days"], [7 * 86400, "7 days"],
];

function openSellModal(t, mode = "fixed") {
  const sellerIsCreator = isMe(t.creator);
  const durationSelect = (id, def) => `
    <select class="select" id="${id}">${DURATIONS.map(([s, l]) => `<option value="${s}" ${s === def ? "selected" : ""}>${l}</option>`).join("")}</select>`;

  const fields = {
    fixed: `
      <div class="field"><label class="label" for="f-price">Price</label>
        <div class="input-group"><input class="input mono" id="f-price" inputmode="decimal" placeholder="0.00" /><span class="input-group__suffix">ETH</span></div></div>`,
    dutch: `
      <div class="row">
        <div class="field"><label class="label" for="f-start">Starting price</label>
          <div class="input-group"><input class="input mono" id="f-start" inputmode="decimal" placeholder="1.00" /><span class="input-group__suffix">ETH</span></div></div>
        <div class="field"><label class="label" for="f-floor">Floor price</label>
          <div class="input-group"><input class="input mono" id="f-floor" inputmode="decimal" placeholder="0.20" /><span class="input-group__suffix">ETH</span></div></div>
      </div>
      <div class="field"><label class="label" for="f-duration">Price drops over</label>${durationSelect("f-duration", 86400)}</div>
      <p class="hint" style="margin-top:10px">The price falls steadily to the floor, then stays there. The first person to buy gets it.</p>`,
    auction: `
      <div class="row">
        <div class="field"><label class="label" for="f-price">Reserve price</label>
          <div class="input-group"><input class="input mono" id="f-price" inputmode="decimal" placeholder="0.10" /><span class="input-group__suffix">ETH</span></div></div>
        <div class="field"><label class="label" for="f-duration">Duration</label>${durationSelect("f-duration", 86400)}</div>
      </div>
      <p class="hint" style="margin-top:10px">The first bid must meet the reserve. The marketplace holds your piece until the auction ends.</p>`,
    private: `
      <div class="row">
        <div class="field"><label class="label" for="f-price">Price</label>
          <div class="input-group"><input class="input mono" id="f-price" inputmode="decimal" placeholder="0.00" /><span class="input-group__suffix">ETH</span></div></div>
        <div class="field"><label class="label" for="f-duration">Link valid for</label>${durationSelect("f-duration", 7 * 86400)}</div>
      </div>
      <p class="hint" style="margin-top:10px">Sign an offer for free, with no gas, and send the link to a buyer. Whoever opens it can buy at this price until it expires.</p>`,
  };

  const tabs = [["fixed", "Fixed"], ["dutch", "Declining"], ["auction", "Auction"], ["private", "Private link"]];

  openModal(`
    <div class="modal__head">
      ${media(t, "modal__thumb")}
      <div><h2 class="modal__title">Sell “${esc(t.meta.name)}”</h2><p class="modal__sub">Choose how you'd like to sell</p></div>
    </div>
    <div class="modal__body">
      <div class="segmented" role="group" aria-label="Sale type">
        ${tabs.map(([id, l]) => `<button type="button" data-mode="${id}" aria-pressed="${id === mode}">${l}</button>`).join("")}
      </div>
      <div style="margin-top:20px">${fields[mode]}</div>
      <div id="sell-breakdown"></div>
    </div>
    <div class="modal__foot">
      <ol class="steps" id="sell-steps" hidden></ol>
      <button class="btn btn--primary btn--block" id="sell-submit">${mode === "private" ? "Sign and create link" : mode === "auction" ? "Start auction" : "List for sale"}</button>
    </div>`);

  $$("[data-mode]").forEach((b) => (b.onclick = () => openSellModal(t, b.dataset.mode)));

  const update = () => {
    const priceEl = mode === "dutch" ? $("#f-floor") : $("#f-price");
    const p = parseEth(priceEl?.value);
    const label = mode === "dutch" ? "You receive at the floor (at least)" : mode === "auction" ? "You receive at the reserve (at least)" : "You receive";
    $("#sell-breakdown").innerHTML = p ? breakdown(p, t, sellerIsCreator, label) : "";
  };
  $$("#modal input").forEach((i) => (i.oninput = () => { i.removeAttribute("aria-invalid"); update(); }));
  $("#modal input")?.focus();

  $("#sell-submit").onclick = () => guard($("#sell-submit"), () => submitSale(t, mode));
}

async function submitSale(t, mode) {
  const invalid = (id) => { $(id).setAttribute("aria-invalid", "true"); $(id).focus(); };
  const duration = Number($("#f-duration")?.value ?? 0);
  let price, start, floor;
  if (mode === "dutch") {
    start = parseEth($("#f-start").value);
    floor = parseEth($("#f-floor").value);
    if (!start) return invalid("#f-start");
    if (!floor) return invalid("#f-floor");
    if (start <= floor) {
      invalid("#f-start");
      return toast("error", "Check your prices", "The starting price must be higher than the floor.");
    }
  } else {
    price = parseEth($("#f-price").value);
    if (!price) return invalid("#f-price");
  }

  if (!(await requireWallet())) return;
  const { nft: wNft, market: wMarket } = writable();
  const needsApproval = !(await nft.isApprovedForAll(wallet.account, marketAddr()));

  const stepsEl = $("#sell-steps");
  const finalLabel = mode === "private" ? "Sign the offer" : mode === "auction" ? "Start the auction" : "Confirm the listing";
  const steps = [
    ...(needsApproval ? [["Allow Atelier to transfer your pieces", "One-time approval for this collection"]] : []),
    [finalLabel, mode === "private" ? "Free. Just a signature, no gas." : "One transaction"],
  ];
  const drawSteps = (active, done = -1) => {
    stepsEl.hidden = false;
    stepsEl.innerHTML = steps.map(([title, sub], i) => `
      <li class="${i <= done ? "is-done" : i === active ? "is-active" : ""}">
        <span class="dot">${i <= done ? "✓" : i + 1}</span><div>${title}<small>${sub}</small></div>
      </li>`).join("");
  };

  let i = 0;
  drawSteps(0);
  if (needsApproval) {
    if (!(await runTx("Approve marketplace", () => wNft.setApprovalForAll(marketAddr(), true)))) return drawSteps(0);
    drawSteps(++i, i - 1);
  }

  if (mode === "private") return createPrivateLink(t, price, duration);

  const send = {
    fixed: () => wMarket.list(deployment.nft, t.id, price),
    dutch: () => wMarket.listDutch(deployment.nft, t.id, start, floor, duration),
    auction: () => wMarket.createAuction(deployment.nft, t.id, price, duration),
  }[mode];
  const ok = await runTx(mode === "auction" ? "Start auction" : "List for sale", send);
  if (!ok) return drawSteps(i, i - 1);
  drawSteps(-1, steps.length - 1);
  closeModal();
  await refresh();
  toast("success", mode === "auction" ? "Your auction is live" : "Listed for sale", `“${esc(t.meta.name)}” is now on the market.`);
}

// ------------------------------------------------------------------------------------------------- Private links (EIP-712)

const LINKS_KEY = `atelier:links:${CHAIN_ID}`;
const loadLinks = () => {
  try { return JSON.parse(localStorage.getItem(LINKS_KEY) ?? "[]"); } catch { return []; }
};
const saveLinks = (links) => {
  try { localStorage.setItem(LINKS_KEY, JSON.stringify(links)); } catch { /* storage unavailable */ }
};

async function createPrivateLink(t, price, duration) {
  const order = {
    seller: wallet.account,
    nft: deployment.nft,
    tokenId: BigInt(t.id),
    price,
    nonce: BigInt(ethers.hexlify(ethers.randomBytes(8))),
    deadline: BigInt(chainNow() + duration),
  };
  const domain = { name: "Atelier Marketplace", version: "1", chainId: CHAIN_ID, verifyingContract: marketAddr() };
  const types = {
    Order: [
      { name: "seller", type: "address" }, { name: "nft", type: "address" }, { name: "tokenId", type: "uint256" },
      { name: "price", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ],
  };

  let signature;
  try {
    signature = await wallet.signer.signTypedData(domain, types, order);
  } catch (err) {
    return toast("error", "Signature cancelled", esc(explainError(err)));
  }

  const payload = base64UrlEncode({
    c: CHAIN_ID, m: marketAddr(), s: signature,
    o: Object.fromEntries(Object.entries(order).map(([k, v]) => [k, v.toString()])),
  });
  const url = `${location.origin}${location.pathname}${location.search}#/order/${payload}`;
  saveLinks([{ url, seller: wallet.account, tokenId: t.id, price: price.toString(), nonce: order.nonce.toString(), deadline: Number(order.deadline), created: Date.now() }, ...loadLinks()]);

  openModal(`
    <div class="modal__head">${media(t, "modal__thumb")}
      <div><h2 class="modal__title">Your sale link is ready</h2><p class="modal__sub">${eth(price)} ETH · expires ${new Date(Number(order.deadline) * 1000).toLocaleDateString()}</p></div></div>
    <div class="modal__body">
      <p class="hint" style="margin-bottom:12px">Send this link to your buyer. Signing it cost you nothing, and you can cancel it any time from your profile.</p>
      <div class="link-box"><input class="input" readonly value="${esc(url)}" id="link-input" /><button class="btn btn--primary" id="copy-link">Copy</button></div>
    </div>
    <div class="modal__foot"><button class="btn btn--secondary" data-close>Done</button></div>`);
  $("#copy-link").onclick = () => copy(url);
  $("#link-input").onclick = (e) => e.target.select();
}

async function renderOrder(payload) {
  let data;
  try {
    data = base64UrlDecode(payload);
  } catch {
    data = null;
  }
  const bad = (title, body) =>
    ($("#main").innerHTML = `<div class="wrap" style="padding:72px 0">${empty(title, body, `<a class="btn btn--secondary btn--sm" href="#/">Browse the marketplace</a>`)}</div>`);
  if (!data?.o || !data.s) return bad("This link is broken", "Check that you copied the whole link.");
  if (data.c !== CHAIN_ID || !same(data.m, marketAddr())) return bad("Wrong network", `This link was made for a different network or marketplace.`);

  const o = { ...data.o, tokenId: BigInt(data.o.tokenId), price: BigInt(data.o.price), nonce: BigInt(data.o.nonce), deadline: BigInt(data.o.deadline) };
  const t = state.tokens.get(Number(o.tokenId));
  if (!t || !same(o.nft, deployment.nft)) return bad("Piece not found", "This link points to a piece that doesn't exist here.");

  const used = await market.nonceUsed(o.seller, o.nonce);
  const expired = chainNow() > Number(o.deadline);
  const stale = !same(t.owner, o.seller);
  const status = used ? "This offer has already been used or was cancelled."
    : expired ? "This offer has expired."
    : stale ? "The seller no longer owns this piece."
    : null;

  $("#main").innerHTML = `
    <div class="wrap">
      <nav class="crumb"><a href="#/item/${t.id}">← View piece</a></nav>
      <article class="item">
        <div class="item__media">${media(t)}</div>
        <div>
          <p class="eyebrow">Private sale</p>
          <h1 class="item__title">${esc(t.meta.name)}</h1>
          <div class="people">
            <div class="person">${avatar(t.creator, 34)}<div><div class="person__k">Artist</div><div class="person__v">${personLink(t.creator)}</div></div></div>
            <div class="person">${avatar(o.seller, 34)}<div><div class="person__k">Offered by</div><div class="person__v">${personLink(o.seller)}</div></div></div>
          </div>
          <div class="panel">
            <div class="panel__k"><span>Price</span><span class="badge ${status ? "" : "badge--good"}">${status ? "Unavailable" : "Signed offer"}</span></div>
            <div class="price">${eth(o.price)} <small>ETH</small></div>
            <div class="panel__sub">${status ?? `Valid until ${new Date(Number(o.deadline) * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`}</div>
            ${status ? "" : isMe(o.seller)
              ? `<p class="hint">This is your own offer. Share the link with a buyer.</p>`
              : `<button class="btn btn--primary btn--block" id="fulfill">${wallet.account ? `Buy for ${eth(o.price)} ETH` : "Connect wallet"}</button>`}
            ${note("The seller signed this offer off-chain. The marketplace checks the signature when you buy, so the price can't be changed.")}
          </div>
        </div>
      </article>
    </div>`;

  const btn = $("#fulfill");
  if (btn) btn.onclick = () => guard(btn, async () => {
    if (!(await requireWallet())) return;
    if (await runTx(`Buy “${t.meta.name}”`, () => writable().market.fulfillOrder(o, data.s, { value: o.price }))) {
      await loadAll();
      location.hash = `#/item/${t.id}`;
      toast("success", "It's yours", `“${esc(t.meta.name)}” is now in your collection.`);
    }
  });
}

function openEditPrice(t, listing) {
  openModal(`
    <div class="modal__head">${media(t, "modal__thumb")}
      <div><h2 class="modal__title">Edit price</h2><p class="modal__sub">Currently ${eth(listing.endPrice)} ETH</p></div></div>
    <div class="modal__body">
      <div class="field"><label class="label" for="f-price">New price</label>
        <div class="input-group"><input class="input mono" id="f-price" inputmode="decimal" value="${ethers.formatEther(listing.endPrice)}" /><span class="input-group__suffix">ETH</span></div></div>
      <div id="edit-breakdown">${breakdown(listing.endPrice, t, isMe(t.creator))}</div>
    </div>
    <div class="modal__foot"><button class="btn btn--primary btn--block" id="edit-submit">Update price</button></div>`);
  const input = $("#f-price");
  input.select();
  input.oninput = () => {
    const p = parseEth(input.value);
    $("#edit-breakdown").innerHTML = p ? breakdown(p, t, isMe(t.creator)) : "";
  };
  $("#edit-submit").onclick = () => guard($("#edit-submit"), async () => {
    const p = parseEth(input.value);
    if (!p) return input.setAttribute("aria-invalid", "true");
    if (await runTx("Update price", () => writable().market.updatePrice(listing.id, p))) {
      closeModal();
      await refresh();
    }
  });
}

// ------------------------------------------------------------------------------------------------- Create

const draft = { seed: randomSeed(), source: "generate", url: "", name: "", description: "", royalty: 5 };

function draftImage() {
  if (draft.source === "url") return safeImage(draft.url.trim());
  return svgDataUri(generateArtwork(draft.seed));
}

function renderCreate() {
  $("#main").innerHTML = `
    <div class="wrap">
      <section class="page-head" style="padding-bottom:36px">
        <div>
          <p class="eyebrow">Create</p>
          <h1 class="display" style="max-width:20ch">Mint a new piece</h1>
          <p class="lede">Your artwork and its details are stored fully on-chain. You set the royalty you earn each time it resells.</p>
        </div>
      </section>
      <div class="create">
        <form class="create__form" id="create-form" novalidate>
          <div class="form-section">
            <h3>Artwork</h3>
            <p>Generate an original composition, or link to an image you've already hosted.</p>
            <div class="segmented" role="group" aria-label="Artwork source" style="max-width:320px">
              <button type="button" data-src="generate" aria-pressed="${draft.source === "generate"}">Generate</button>
              <button type="button" data-src="url" aria-pressed="${draft.source === "url"}">Image link</button>
            </div>
            ${draft.source === "url" ? `
              <div class="field" style="margin-top:16px"><label class="label" for="c-url">Image URL <small>https:// or ipfs://</small></label>
                <input class="input" id="c-url" placeholder="https://…" value="${esc(draft.url)}" /></div>` : ""}
          </div>
          <div class="form-section">
            <h3>Details</h3>
            <p>This is how collectors will find and recognise your work.</p>
            <div class="field"><label class="label" for="c-name">Title <small><span id="name-count">${draft.name.length}</span>/60</small></label>
              <input class="input" id="c-name" maxlength="60" placeholder="e.g. Field Notes II" value="${esc(draft.name)}" required /></div>
            <div class="field"><label class="label" for="c-desc">Description <small>optional</small></label>
              <textarea class="textarea" id="c-desc" maxlength="400" placeholder="What inspired this piece?">${esc(draft.description)}</textarea></div>
          </div>
          <div class="form-section">
            <h3>Royalty</h3>
            <p>Your cut each time someone resells this piece, paid automatically by the marketplace.</p>
            <div class="field">
              <label class="label" for="c-royalty">Royalty <span class="royalty-value" id="royalty-value">${draft.royalty}%</span></label>
              <input type="range" id="c-royalty" min="0" max="10" step="0.5" value="${draft.royalty}" />
              <p class="hint">Up to 10%. Most artists choose 5–7.5%.</p>
            </div>
          </div>
          <div class="form-section">
            <button class="btn btn--primary btn--block" type="submit" id="mint-btn">Mint piece</button>
            <p class="hint" style="margin-top:10px;text-align:center">Minting is free on the platform. You only pay network gas.</p>
          </div>
        </form>
        <aside class="create__preview" aria-label="Preview">
          <p class="eyebrow">Preview</p>
          <div class="card">
            <div class="card__media" id="preview-media"></div>
            <div class="card__body">
              <h3 class="card__title" id="preview-name"></h3>
              <div class="card__by">${wallet.account ? `${avatar(wallet.account, 16)} You` : "Your wallet"}</div>
              <div class="card__foot"><span class="k">Royalty</span><span class="v" id="preview-royalty"></span></div>
            </div>
          </div>
          ${draft.source === "generate" ? `<div class="preview-tools"><span class="hint mono">Seed ${draft.seed}</span><button type="button" class="btn btn--secondary btn--sm" id="shuffle">Shuffle</button></div>` : ""}
        </aside>
      </div>
    </div>`;

  const paint = () => {
    const img = draftImage();
    $("#preview-media").innerHTML = img
      ? `<img src="${esc(img)}" alt="Artwork preview" />`
      : `<div style="display:grid;place-items:center;height:100%;color:var(--faint);font-size:14px;padding:24px;text-align:center">Paste an image link to preview it here</div>`;
    $("#preview-name").textContent = draft.name || "Untitled";
    $("#preview-royalty").textContent = `${draft.royalty}%`;
  };
  paint();

  $$("[data-src]").forEach((b) => (b.onclick = () => { draft.source = b.dataset.src; renderCreate(); }));
  $("#shuffle")?.addEventListener("click", () => { draft.seed = randomSeed(); renderCreate(); });
  $("#c-url")?.addEventListener("input", (e) => { draft.url = e.target.value; paint(); });
  $("#c-name").oninput = (e) => { draft.name = e.target.value; $("#name-count").textContent = draft.name.length; e.target.removeAttribute("aria-invalid"); paint(); };
  $("#c-desc").oninput = (e) => (draft.description = e.target.value);
  $("#c-royalty").oninput = (e) => { draft.royalty = Number(e.target.value); $("#royalty-value").textContent = `${draft.royalty}%`; paint(); };
  $("#create-form").onsubmit = (e) => { e.preventDefault(); guard($("#mint-btn"), mint); };
}

async function mint() {
  const name = draft.name.trim();
  if (!name) {
    $("#c-name").setAttribute("aria-invalid", "true");
    $("#c-name").focus();
    return toast("error", "Add a title", "Every piece needs a title.");
  }
  let image = draftImage();
  if (draft.source === "url") {
    const raw = draft.url.trim();
    image = raw.startsWith("ipfs://") ? raw : safeImage(raw);
    if (!image) {
      $("#c-url")?.setAttribute("aria-invalid", "true");
      return toast("error", "Check the image link", "Use an https:// or ipfs:// address.");
    }
  }
  if (!(await requireWallet())) return;

  const uri = buildTokenUri({ name, description: draft.description.trim(), image });
  const receipt = await runTx(`Mint “${name}”`, () => writable().nft.mint(uri, Math.round(draft.royalty * 100)));
  if (!receipt) return;

  const minted = receipt.logs.map((l) => { try { return nft.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === "Minted");
  const id = Number(minted.args.tokenId);
  Object.assign(draft, { seed: randomSeed(), name: "", description: "", url: "" });
  await loadAll();
  const t = state.tokens.get(id);

  openModal(`
    <div class="modal__body" style="padding-top:28px;text-align:center">
      <div style="width:140px;margin:0 auto 18px" class="card__media">${media(t)}</div>
      <h2 class="modal__title">“${esc(t.meta.name)}” is minted</h2>
      <p class="modal__sub" style="margin-top:6px">It's in your collection as token #${id}. Want to put it up for sale?</p>
    </div>
    <div class="modal__foot">
      <button class="btn btn--primary btn--block" id="after-sell">List it for sale</button>
      <a class="btn btn--ghost" href="#/item/${id}" data-close>View piece</a>
    </div>`);
  $("#after-sell").onclick = () => { location.hash = `#/item/${id}`; setTimeout(() => openSellModal(t), 50); };
}

// ------------------------------------------------------------------------------------------------- Profile

function renderProfile(addrParam) {
  const addr = addrParam ? ethers.getAddress(addrParam) : wallet.account;
  if (!addr) {
    $("#main").innerHTML = `<div class="wrap" style="padding:72px 0">${empty("Connect to see your collection",
      "Your pieces, listings and earnings will show up here.",
      `<button class="btn btn--primary btn--sm" id="profile-connect">Connect wallet</button>`)}</div>`;
    $("#profile-connect").onclick = (e) => guard(e.currentTarget, requireWallet);
    return;
  }
  const own = isMe(addr);
  const tokens = [...state.tokens.values()];
  const collected = tokens.filter((t) => same(holderOf(t), addr));
  const created = tokens.filter((t) => same(t.creator, addr));
  const onSale = collected.filter((t) => marketOf(t.id).kind !== "none");
  const links = own ? loadLinks().filter((l) => same(l.seller, addr)) : [];

  const tabs = [
    ["collected", "Collected", collected.length],
    ["created", "Created", created.length],
    ["selling", "On sale", onSale.length],
    ...(own ? [["links", "Private links", links.length]] : []),
  ];
  if (!tabs.some(([id]) => id === state.profileTab)) state.profileTab = "collected";

  const grids = {
    collected: collected.length ? collected.map(card).join("") : empty(own ? "You don't own any pieces yet" : "No pieces yet", own ? "Pieces you mint or buy will appear here." : "This collector hasn't collected anything yet.", own ? `<a class="btn btn--primary btn--sm" href="#/">Explore the marketplace</a>` : ""),
    created: created.length ? created.map(card).join("") : empty("Nothing created yet", own ? "Mint your first piece and start earning royalties." : "This account hasn't minted anything.", own ? `<a class="btn btn--primary btn--sm" href="#/create">Create a piece</a>` : ""),
    selling: onSale.length ? onSale.map(card).join("") : empty("Nothing on sale", own ? "Open one of your pieces and choose “Sell this piece”." : "Nothing listed right now."),
  };

  $("#main").innerHTML = `
    <div class="wrap">
      <section class="profile-head">
        <div class="profile-id">
          ${avatar(addr, 72)}
          <div>
            <h1 class="h2">${own ? "Your profile" : short(addr)}</h1>
            <div class="addr-line"><span class="mono">${short(addr)}</span>
              <button class="icon-btn" id="copy-addr" aria-label="Copy address"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg></button>
              ${addressUrl(addr) ? `<a href="${addressUrl(addr)}" target="_blank" rel="noopener" class="muted">Explorer ↗</a>` : ""}
            </div>
          </div>
        </div>
        ${own ? `
          <div class="balance">
            <div><div class="balance__k">Available to withdraw</div><div class="balance__v">${eth(state.credits)} ETH</div></div>
            <button class="btn btn--primary btn--sm" id="withdraw" ${state.credits === 0n ? "disabled" : ""}>Withdraw</button>
          </div>` : ""}
      </section>
      <div class="tabs" role="tablist">
        ${tabs.map(([id, l, n]) => `<button role="tab" data-tab="${id}" aria-selected="${state.profileTab === id}">${l}<span class="count">${n}</span></button>`).join("")}
      </div>
      ${state.profileTab === "links" ? linksTable(links) : `<div class="grid">${grids[state.profileTab]}</div>`}
    </div>`;

  $$("[data-tab]").forEach((b) => (b.onclick = () => { state.profileTab = b.dataset.tab; renderProfile(addrParam); }));
  $("#copy-addr").onclick = () => copy(addr, "Address");
  const w = $("#withdraw");
  if (w) w.onclick = () => guard(w, async () => {
    const amount = state.credits;
    if (await runTx(`Withdraw ${eth(amount)} ETH`, () => writable().market.withdraw())) await refresh();
  });
  $$("[data-cancel-nonce]").forEach((b) => (b.onclick = () => guard(b, async () => {
    if (await runTx("Cancel sale link", () => writable().market.cancelOrder(BigInt(b.dataset.cancelNonce)))) {
      saveLinks(loadLinks().filter((l) => l.nonce !== b.dataset.cancelNonce));
      renderProfile(addrParam);
    }
  })));
  $$("[data-copy]").forEach((b) => (b.onclick = () => copy(b.dataset.copy)));
}

function linksTable(links) {
  if (!links.length) {
    return `<div class="grid">${empty("No private links", "Create one from any piece you own: choose “Sell this piece”, then “Private link”.")}</div>`;
  }
  return `
    <ul class="activity" style="margin-bottom:72px">
      ${links.map((l) => {
        const t = state.tokens.get(l.tokenId);
        const expired = chainNow() > l.deadline;
        return `
          <li style="grid-template-columns:52px 1fr auto">
            <span style="width:44px;height:44px;border-radius:4px;overflow:hidden;border:1px solid var(--line)">${t ? media(t) : ""}</span>
            <span><strong style="font-weight:500">${esc(t?.meta.name ?? `#${l.tokenId}`)}</strong><br>
              <span class="muted">${eth(BigInt(l.price))} ETH · ${expired ? "expired" : `expires ${new Date(l.deadline * 1000).toLocaleDateString()}`}</span></span>
            <span style="display:flex;gap:6px">
              <button class="btn btn--secondary btn--sm" data-copy="${esc(l.url)}">Copy</button>
              <button class="btn btn--ghost btn--sm" data-cancel-nonce="${l.nonce}">Cancel</button>
            </span>
          </li>`;
      }).join("")}
    </ul>`;
}

// =================================================================================================
// Chrome (header, banner) & router
// =================================================================================================

function renderChrome() {
  const btn = $("#connect-btn");
  if (wallet.account) {
    btn.className = "btn btn--secondary btn--sm";
    btn.innerHTML = `${avatar(wallet.account, 18)} <span class="mono">${short(wallet.account)}</span>`;
    btn.title = "View your profile";
  } else {
    btn.className = "btn btn--primary btn--sm";
    btn.textContent = hasInjectedWallet() ? "Connect wallet" : "Get a wallet";
    btn.title = "";
  }

  const pill = $("#network-pill");
  pill.textContent = NETWORK.name;
  pill.classList.toggle("is-off", !state.loaded);

  const chip = $("#balance-chip");
  chip.hidden = !(wallet.account && state.credits > 0n);
  chip.textContent = `${eth(state.credits)} ETH to withdraw`;

  const banner = $("#network-banner");
  banner.hidden = !isWrongNetwork();
  if (isWrongNetwork()) {
    banner.innerHTML = `<div class="banner__inner"><span>Your wallet is on a different network. Atelier runs on <strong>${esc(NETWORK.name)}</strong>.</span><button class="btn btn--secondary btn--sm" id="switch-net">Switch network</button></div>`;
    $("#switch-net").onclick = () => switchNetwork().catch((e) => toast("error", "Couldn't switch", esc(explainError(e))));
  }
  if (deployment) {
    $("#footer-meta").innerHTML = `<span class="mono">Marketplace ${short(deployment.marketplace)}</span> · <span class="mono">Collection ${short(deployment.nft)}</span>`;
  }
}

const ROUTES = [
  [/^#?\/?$/, "explore", renderExplore],
  [/^#\/auctions$/, "auctions", renderAuctions],
  [/^#\/create$/, "create", renderCreate],
  [/^#\/profile(?:\/(0x[0-9a-fA-F]{40}))?$/, "profile", renderProfile],
  [/^#\/item\/(\d+)$/, "explore", renderItem],
  [/^#\/order\/([\w-]+)$/, null, renderOrder],
];

let lastHash = null;
function render({ keepScroll = false } = {}) {
  const hash = location.hash || "#/";
  const [re, nav, view] = ROUTES.find(([r]) => r.test(hash)) ?? ROUTES[0];
  const match = hash.match(re) ?? [];
  $$("[data-nav]").forEach((a) => (a.dataset.nav === nav ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  itemToken = null;
  if (!state.loaded) {
    $("#main").innerHTML = `<div class="wrap" style="padding-top:56px">${skeletonGrid()}</div>`;
    return;
  }
  const y = window.scrollY;
  view(match[1]);
  if (keepScroll && hash === lastHash) window.scrollTo(0, y);
  else if (hash !== lastHash) window.scrollTo(0, 0);
  lastHash = hash;
}

// Live clocks and falling prices.
let rerenderQueued = false;
function tick() {
  const now = chainNow();
  $$("[data-ends]").forEach((el) => {
    const left = Number(el.dataset.ends) - now;
    el.textContent = countdown(left);
    if (left <= 0 && el.hasAttribute("data-rerender") && !rerenderQueued) {
      rerenderQueued = true;
      setTimeout(() => { rerenderQueued = false; render({ keepScroll: true }); }, 1200);
    }
  });
  $$("[data-dutch]").forEach((el) => {
    const l = state.listings.find((x) => x.id === Number(el.dataset.dutch));
    if (l) el.textContent = eth(dutchPrice(l, now));
  });
  $$("[data-decay]").forEach((el) => {
    const l = state.listings.find((x) => x.id === Number(el.dataset.decay));
    if (l) el.style.width = `${decayPct(l)}%`;
  });
}

async function boot() {
  renderChrome();
  render();

  $("#connect-btn").onclick = async () => {
    if (wallet.account) return (location.hash = "#/profile");
    if (!hasInjectedWallet()) return window.open("https://metamask.io/download/", "_blank", "noopener");
    try {
      await connect();
    } catch (err) {
      toast("error", "Couldn't connect", esc(explainError(err)));
    }
  };

  if (!(await loadDeployment())) {
    renderChrome();
    return renderSetup();
  }

  onWalletChange(async () => {
    renderChrome();
    if (state.loaded) await refresh();
  });
  try {
    await initWallet();
  } catch (err) {
    console.warn("Wallet init failed", err);
  }

  try {
    await loadAll();
  } catch (err) {
    console.error(err);
    toast("error", "Couldn't load the marketplace", esc(explainError(err)), { sticky: true });
    return;
  }
  render();

  window.addEventListener("hashchange", () => render());
  setInterval(tick, 1000);
  // Pick up other people's activity every 20 seconds while the tab is visible.
  setInterval(() => {
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (document.visibilityState === "visible" && !$("#modal").open && !typing) refresh().catch(() => {});
  }, 20_000);
}

boot();
