// Ripcord: Solana meme coin paper-trading bot.
// Real live prices (DexScreener), virtual money. One tick = scan + manage positions.
// LOOP_SECONDS=270 keeps ticking every TICK_SECONDS inside one GitHub Actions run.
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const STATE_FILE = new URL('data/state.json', ROOT);
const DS = 'https://api.dexscreener.com';
const RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const QUOTES = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);
const MIN = 60_000;

const num = (v) => Number(v) || 0;
const day = (ts) => new Date(ts).toISOString().slice(0, 10);

async function get(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 80)}`);
  return r.json();
}

export function freshState(cfg, now = Date.now()) {
  return {
    startedAt: now, startBalanceUsd: cfg.startBalanceUsd, cashUsd: cfg.startBalanceUsd,
    positions: [], closed: [], equity: [], cooldown: {}, rug: {}, walletSigs: {}, days: {}, lastRun: 0,
  };
}

// ---------- fill model: % fee per side + constant-product price impact ----------
export function impact(usd, liqUsd) {
  return Math.min(0.5, (2 * usd) / Math.max(liqUsd, 1));
}
export function buyFill(usd, price, liqUsd, fee) {
  return (usd * (1 - fee)) / (price * (1 + impact(usd, liqUsd)));
}
export function sellFill(qty, price, liqUsd, fee) {
  const gross = qty * price;
  return gross * (1 - impact(gross, liqUsd)) * (1 - fee);
}

// ---------- entry filter: returns null when OK, else the first failing reason ----------
export function entryReject(p, now, e) {
  const liq = num(p.liquidity?.usd);
  const mcap = num(p.marketCap || p.fdv);
  const ageMin = (now - num(p.pairCreatedAt)) / MIN;
  const m5 = p.txns?.m5 || {}, h1 = p.txns?.h1 || {};
  const rM5 = num(m5.buys) / Math.max(num(m5.sells), 1);
  const rH1 = num(h1.buys) / Math.max(num(h1.sells), 1);
  const chM5 = num(p.priceChange?.m5), chH1 = num(p.priceChange?.h1);
  const volLiq = num(p.volume?.h1) / Math.max(liq, 1);
  if (!liq) return 'no pool liquidity';
  if (liq < e.minLiquidityUsd) return 'liquidity too low';
  if (liq > e.maxLiquidityUsd) return 'liquidity too high';
  if (mcap < e.minMcapUsd) return 'mcap too low';
  if (mcap > e.maxMcapUsd) return 'mcap too high';
  if (ageMin < e.minAgeMin) return 'too new';
  if (ageMin > e.maxAgeHours * 60) return 'too old';
  if (num(m5.buys) < e.minBuysM5) return 'few buys 5m';
  if (rM5 < e.minBuyRatioM5) return 'sellers win 5m';
  if (rH1 < e.minBuyRatioH1) return 'sellers win 1h';
  if (chM5 < e.minChangeM5) return 'no 5m momentum';
  if (chM5 > e.maxChangeM5) return 'candle too vertical';
  if (chH1 < e.minChangeH1) return 'no 1h trend';
  if (chH1 > e.maxChangeH1) return 'already pumped';
  if (volLiq < e.minVolLiqH1) return 'low volume';
  if (score(p) < e.minScore) return 'low score';
  return null;
}

export function score(p) {
  const liq = Math.max(num(p.liquidity?.usd), 1);
  const rM5 = num(p.txns?.m5?.buys) / Math.max(num(p.txns?.m5?.sells), 1);
  return (rM5 - 1) * 2 + Math.min(num(p.volume?.h1) / liq, 5) * 0.5 + num(p.priceChange?.m5) / 10;
}

export function features(p, now) {
  return {
    liq: Math.round(num(p.liquidity?.usd)), mcap: Math.round(num(p.marketCap || p.fdv)),
    ageMin: Math.round((now - num(p.pairCreatedAt)) / MIN),
    buysM5: num(p.txns?.m5?.buys), sellsM5: num(p.txns?.m5?.sells),
    chM5: num(p.priceChange?.m5), chH1: num(p.priceChange?.h1),
    volH1: Math.round(num(p.volume?.h1)), score: +score(p).toFixed(2), dex: p.dexId,
  };
}

// ---------- exit logic: pure, so it is testable ----------
export function exitDecision(pos, price, liq, now, x) {
  const gain = price / pos.entryPrice - 1;
  const held = (now - pos.entryTs) / MIN;
  if (pos.walletSold) return { act: 'close', why: 'copied wallet sold' };
  if (liq && pos.entryLiq && liq < pos.entryLiq * (1 - x.liqDropPct)) return { act: 'close', why: 'liquidity pulled' };
  if (price <= pos.stop) return { act: 'close', why: pos.tp1Done ? 'trailing stop' : 'stop loss' };
  if (gain >= x.hardTpPct) return { act: 'close', why: 'moonshot take profit' };
  if (!pos.tp1Done && gain >= x.tp1Pct) return { act: 'partial', why: 'take profit 1' };
  if (held >= x.maxHoldMin) return { act: 'close', why: 'max hold time' };
  if (held >= x.staleMin && gain < x.staleMinGainPct && !pos.tp1Done) return { act: 'close', why: 'dead coin' };
  return { act: 'none' };
}

// ---------- data sources ----------
async function discover() {
  const lists = await Promise.allSettled([
    get(`${DS}/token-profiles/latest/v1`),
    get(`${DS}/token-boosts/latest/v1`),
    get(`${DS}/token-boosts/top/v1`),
  ]);
  const mints = new Set();
  for (const l of lists) if (l.status === 'fulfilled') for (const t of l.value) if (t.chainId === 'solana') mints.add(t.tokenAddress);
  return [...mints];
}

// best pool per mint (deepest liquidity, quoted in SOL/USDC/USDT)
async function pairsFor(mints) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    let pairs = [];
    try { pairs = await get(`${DS}/tokens/v1/solana/${chunk.join(',')}`); } catch (err) { console.warn('pairs', err.message); continue; }
    for (const p of pairs) {
      const mint = p.baseToken?.address;
      if (!chunk.includes(mint) || !QUOTES.has(p.quoteToken?.address)) continue;
      const prev = out.get(mint);
      if (!prev || num(p.liquidity?.usd) > num(prev.liquidity?.usd)) out.set(mint, p);
    }
  }
  return out;
}

async function rugOk(state, mint, maxScore, now) {
  const c = state.rug[mint];
  if (c && now - c.ts < 6 * 60 * MIN) return c.ok;
  try {
    const r = await get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
    const danger = (r.risks || []).some((k) => k.level === 'danger');
    const ok = !danger && num(r.score_normalised) <= maxScore;
    state.rug[mint] = { ts: now, ok, score: num(r.score_normalised), risks: (r.risks || []).map((k) => k.name).slice(0, 4) };
    return ok;
  } catch {
    return false; // unknown = unsafe; not cached, retried next tick
  }
}

async function rpc(method, params) {
  const r = await get(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (r.error) throw new Error(r.error.message);
  return r.result;
}

// copy-trade: net token change of each tracked wallet in its new transactions
async function walletSignals(state, wallets, now) {
  const buys = new Map(), sells = new Set();
  for (const w of wallets) {
    try {
      const sigs = await rpc('getSignaturesForAddress', [w, { limit: 10 }]);
      const last = state.walletSigs[w];
      state.walletSigs[w] = sigs[0]?.signature || last;
      if (!last) continue; // first sight: remember, never copy old history
      const fresh = [];
      for (const s of sigs) { if (s.signature === last) break; if (!s.err) fresh.push(s); }
      for (const s of fresh.slice(0, 5)) {
        if (s.blockTime && now / 1000 - s.blockTime > 180) continue; // older than 3 min = too late to copy
        const tx = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
        const delta = {};
        for (const b of tx?.meta?.preTokenBalances || []) if (b.owner === w) delta[b.mint] = (delta[b.mint] || 0) - num(b.uiTokenAmount?.uiAmount);
        for (const b of tx?.meta?.postTokenBalances || []) if (b.owner === w) delta[b.mint] = (delta[b.mint] || 0) + num(b.uiTokenAmount?.uiAmount);
        for (const [mint, d] of Object.entries(delta)) {
          if (QUOTES.has(mint)) continue;
          if (d > 0) buys.set(mint, w); else if (d < 0) sells.add(mint);
        }
      }
    } catch (err) { console.warn('wallet', w.slice(0, 6), err.message); }
  }
  return { buys, sells };
}

// ---------- one tick ----------
export async function tick(state, cfg, now = Date.now()) {
  const fee = cfg.costs.feePctPerSide;
  const today = (state.days[day(now)] ||= { scanned: 0, entered: 0, rejects: {} });
  const { buys, sells } = cfg.copy.wallets.length ? await walletSignals(state, cfg.copy.wallets, now) : { buys: new Map(), sells: new Set() };

  // 1) manage open positions
  const held = await pairsFor(state.positions.map((p) => p.mint));
  for (const pos of [...state.positions]) {
    const p = held.get(pos.mint);
    if (sells.has(pos.mint)) pos.walletSold = true;
    if (!p) {
      if (++pos.missing >= cfg.exit.missingTicks) closePos(state, pos, 0, 'pair vanished (rug)', now, cfg);
      continue;
    }
    pos.missing = 0;
    const price = num(p.priceUsd), liq = num(p.liquidity?.usd);
    pos.lastPrice = price; pos.lastLiq = liq;
    if (price > pos.peak) pos.peak = price;
    if (pos.tp1Done) pos.stop = Math.max(pos.stop, pos.peak * (1 - cfg.exit.trailPct));
    const d = exitDecision(pos, price, liq, now, cfg.exit);
    if (d.act === 'close') closePos(state, pos, sellFill(pos.qty, price, liq, fee), d.why, now, cfg);
    else if (d.act === 'partial') {
      const q = pos.qty * cfg.exit.tp1SellFraction;
      const got = sellFill(q, price, liq, fee);
      pos.qty -= q; pos.proceedsUsd += got; state.cashUsd += got;
      pos.tp1Done = true; pos.stop = Math.max(pos.entryPrice, pos.peak * (1 - cfg.exit.trailPct)); // never give back the win
      pos.events.push({ ts: now, what: d.why, price, usd: +got.toFixed(2) });
    }
  }

  // 2) find entries
  const heldSet = new Set(state.positions.map((p) => p.mint));
  const mints = [...new Set([...(await discover()), ...buys.keys()])]
    .filter((m) => !heldSet.has(m) && !(state.cooldown[m] > now));
  const pairs = await pairsFor(mints);
  const picks = [];
  for (const [mint, p] of pairs) {
    today.scanned++;
    const copied = buys.has(mint);
    const e = copied ? { ...cfg.entry, ...cfg.copy.relaxedEntry } : cfg.entry;
    const why = entryReject(p, now, e);
    if (why) { today.rejects[why] = (today.rejects[why] || 0) + 1; continue; }
    picks.push({ mint, p, copied, s: score(p) + (copied ? 10 : 0) });
  }
  picks.sort((a, b) => b.s - a.s);
  for (const { mint, p, copied } of picks) {
    if (state.positions.length >= cfg.maxOpen) break;
    if (!(await rugOk(state, mint, cfg.entry.maxRugScore, now))) { today.rejects['rugcheck risk'] = (today.rejects['rugcheck risk'] || 0) + 1; continue; }
    const usd = Math.min(state.cashUsd, equity(state) * (copied ? cfg.copyPositionPct : cfg.positionPct));
    if (usd < 5) break;
    const price = num(p.priceUsd), liq = num(p.liquidity?.usd);
    const qty = buyFill(usd, price, liq, fee);
    state.cashUsd -= usd;
    state.positions.push({
      mint, symbol: p.baseToken.symbol, name: p.baseToken.name, url: p.url, img: p.info?.imageUrl || '',
      source: copied ? 'copy' : 'momentum', wallet: copied ? buys.get(mint) : undefined,
      entryTs: now, entryPrice: price, costUsd: usd, qty, proceedsUsd: 0,
      peak: price, stop: price * (1 + cfg.exit.stopLossPct), tp1Done: false,
      entryLiq: liq, lastPrice: price, lastLiq: liq, missing: 0,
      features: features(p, now), events: [{ ts: now, what: 'buy', price, usd: +usd.toFixed(2) }],
    });
    today.entered++;
    console.log(`BUY ${p.baseToken.symbol} $${usd.toFixed(0)} @ ${price} (${copied ? 'copy' : 'momentum'})`);
  }
  state.lastRun = now;
}

function closePos(state, pos, proceeds, why, now, cfg) {
  state.cashUsd += proceeds;
  const total = pos.proceedsUsd + proceeds;
  state.positions = state.positions.filter((p) => p !== pos);
  state.cooldown[pos.mint] = now + cfg.cooldownMin * MIN;
  state.closed.push({
    mint: pos.mint, symbol: pos.symbol, name: pos.name, url: pos.url, img: pos.img, source: pos.source,
    entryTs: pos.entryTs, exitTs: now, entryPrice: pos.entryPrice, exitPrice: pos.lastPrice,
    costUsd: +pos.costUsd.toFixed(2), proceedsUsd: +total.toFixed(2),
    pnlUsd: +(total - pos.costUsd).toFixed(2), pnlPct: +((total / pos.costUsd - 1) * 100).toFixed(1),
    peakPct: +((pos.peak / pos.entryPrice - 1) * 100).toFixed(1), reason: why, features: pos.features,
  });
  console.log(`SELL ${pos.symbol} ${why} pnl $${(total - pos.costUsd).toFixed(2)}`);
}

export function equity(state) {
  return state.cashUsd + state.positions.reduce((s, p) => s + p.qty * (p.lastPrice || p.entryPrice), 0);
}

function prune(state, now) {
  for (const [m, t] of Object.entries(state.cooldown)) if (t < now) delete state.cooldown[m];
  for (const [m, c] of Object.entries(state.rug)) if (now - c.ts > 24 * 60 * MIN) delete state.rug[m];
  state.equity = state.equity.filter(([t]) => now - t < 30 * 24 * 60 * MIN);
  const keep = Object.keys(state.days).sort().slice(-30);
  state.days = Object.fromEntries(keep.map((k) => [k, state.days[k]]));
}

// ---------- main ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = JSON.parse(fs.readFileSync(new URL('config.json', ROOT)));
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE)) : freshState(cfg);
  const loopMs = num(process.env.LOOP_SECONDS) * 1000, tickMs = (num(process.env.TICK_SECONDS) || 20) * 1000;
  const until = Date.now() + loopMs;
  do {
    const t0 = Date.now();
    try { await tick(state, cfg, t0); } catch (err) { console.error('tick failed', err.message); }
    prune(state, Date.now());
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    const wait = tickMs - (Date.now() - t0);
    if (Date.now() + wait < until) await new Promise((r) => setTimeout(r, Math.max(wait, 0)));
    else break;
  } while (true);
  state.equity.push([Date.now(), +equity(state).toFixed(2)]);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  console.log(`equity $${equity(state).toFixed(2)} | open ${state.positions.length} | closed ${state.closed.length}`);
}
