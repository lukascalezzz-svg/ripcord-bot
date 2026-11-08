// Ripcord v3: a desk of six agents, all plain fast code (no LLM in the hot path).
// v3: $20 runs with a $150 goal, shadow book that grades every decision, outage-safe Guard.
// Scout finds tokens, Filter checks the numbers, Analyst reads the holder map,
// Skeptic vetoes, Sniper sizes the entry, Guard manages exits.
// Runtime-agnostic: Node runs tests/local loops, Supabase (Deno) runs the live desk.

const DS = 'https://api.dexscreener.com';
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
    version: 3, startedAt: now, startBalanceUsd: cfg.startBalanceUsd, cashUsd: cfg.startBalanceUsd,
    positions: [], closed: [], equity: [[now, cfg.startBalanceUsd]], cooldown: {}, rug: {}, walletSigs: {},
    days: {}, feed: [], ticker: [], radar: [], pulse: {}, lastRun: 0,
    run: { n: 1, startUsd: cfg.startBalanceUsd, goalUsd: cfg.goalUsd, startedAt: now, peakUsd: cfg.startBalanceUsd },
    runs: [], shadow: [],
  };
}

// ---------- fill model: % fee per side + fixed network/priority cost + constant-product price impact ----------
export function impact(usd, liqUsd) {
  return Math.min(0.5, (2 * usd) / Math.max(liqUsd, 1));
}
export function buyFill(usd, price, liqUsd, fee, fixed = 0) {
  return (Math.max(usd - fixed, 0) * (1 - fee)) / (price * (1 + impact(usd, liqUsd)));
}
export function sellFill(qty, price, liqUsd, fee, fixed = 0) {
  const gross = qty * price;
  return Math.max(gross * (1 - impact(gross, liqUsd)) * (1 - fee) - fixed, 0);
}

// ---------- Filter: null when OK, else the first failing reason ----------
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
  if (!(num(p.priceUsd) > 0)) return 'no price';
  if (liq < e.minLiquidityUsd) return 'liquidity too low';
  if (liq > e.maxLiquidityUsd) return 'liquidity too high';
  if (mcap < e.minMcapUsd) return 'mcap too low';
  if (mcap > e.maxMcapUsd) return 'mcap too high';
  if (ageMin < e.minAgeMin) return 'too new';
  if (ageMin > e.maxAgeHours * 60) return 'too old';
  if (num(m5.buys) < e.minBuysM5) return 'few buys 5m';
  if (rM5 < e.minBuyRatioM5) return 'sellers win 5m';
  // 5x+ more buys than sells in 5 min is bundled bot buying before a dump, not real demand
  if (e.maxBuyRatioM5 && rM5 > e.maxBuyRatioM5) return 'bot buying 5m';
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

// ---------- Analyst: the facts the Skeptic judges, from a RugCheck report ----------
export function analyze(r) {
  // pools, vaults and known programs are not "holders"
  const skip = new Set(Object.keys(r.knownAccounts || {}));
  for (const m of r.markets || []) for (const k of [m.pubkey, m.liquidityA, m.liquidityB, m.liquidityAAccount?.pubkey, m.liquidityBAccount?.pubkey]) if (typeof k === 'string') skip.add(k);
  const holders = (r.topHolders || []).filter((h) => !skip.has(h.owner) && !skip.has(h.address));
  const top10 = holders.slice(0, 10).reduce((a, h) => a + num(h.pct), 0);
  const lp = Math.max(0, ...(r.markets || []).map((m) => num(m.lp?.lpLockedPct)));
  return {
    holders: num(r.totalHolders), top10: +top10.toFixed(1), topOne: +num(holders[0]?.pct).toFixed(1),
    insiders: num(r.graphInsidersDetected), lpLocked: Math.round(lp), creatorTokens: (r.creatorTokens || []).length,
    mintAuth: !!r.mintAuthority, freezeAuth: !!r.freezeAuthority, rugged: !!r.rugged,
    // low liquidity is the Filter's job, not a rug signal
    dangers: (r.risks || []).filter((k) => k.level === 'danger' && !/liquidity/i.test(k.name)).map((k) => k.name),
  };
}

// ---------- Skeptic: argues against every trade; any hit is a veto (UI copy is Serbian) ----------
export function skepticVeto(a, p, s) {
  if (a.rugged) return 'već rugovan';
  if (a.mintAuth) return 'dev može da štampa nove tokene';
  if (a.freezeAuth) return 'dev može da zamrzne tuđe wallete';
  if (a.dangers.length) return `RugCheck: ${a.dangers[0]}`;
  if (a.topOne > s.maxSingleHolderPct) return `jedan wallet drži ${a.topOne}%`;
  if (a.top10 > s.maxTop10Pct) return `top 10 holdera drži ${a.top10}%`;
  if (a.insiders > s.maxInsiders) return `${a.insiders} povezanih insajder walleta`;
  if (a.holders < s.minHolders) return `samo ${a.holders} holdera`;
  if (a.lpLocked < s.minLpLockedPct) return `LP zaključan samo ${a.lpLocked}%`;
  if (a.creatorTokens > s.maxCreatorTokens) return `dev je već napravio ${a.creatorTokens} tokena`;
  const liq = num(p.liquidity?.usd), mc = num(p.marketCap || p.fdv);
  if (mc && liq / mc < s.minLiqToMcap) return `tanka likvidnost (${((liq / mc) * 100).toFixed(1)}% od mcap)`;
  // burned LP does not stop a rug: top holders can still sell into the pool and drain it
  const dump = liq ? (a.top10 / 100) * mc / liq : 0;
  if (s.maxTop10DumpToLiq && dump > s.maxTop10DumpToLiq) return `top 10 može da isprazni pul (${dump.toFixed(2)}x likvidnosti)`;
  return null;
}

export function riskOf(a, vetoed) {
  return Math.min(1, a.top10 / 60 + (a.insiders ? 0.15 : 0) + (a.holders < 300 ? 0.15 : 0) + (a.lpLocked < 90 ? 0.2 : 0) + (vetoed ? 0.3 : 0));
}

// ---------- Guard: exit logic, pure so it is testable ----------
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

// best pool per mint (deepest liquidity, quoted in SOL/USDC/USDT).
// out.failed = some chunk errored, so a missing mint means "unknown", not "rugged".
async function pairsFor(mints) {
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));
  await Promise.all(chunks.map(async (chunk) => {
    let pairs = [];
    try { pairs = await get(`${DS}/tokens/v1/solana/${chunk.join(',')}`); } catch (err) { console.warn('pairs', err.message); out.failed = true; return; }
    for (const p of pairs) {
      const mint = p.baseToken?.address;
      if (!chunk.includes(mint) || !QUOTES.has(p.quoteToken?.address)) continue;
      const prev = out.get(mint);
      if (!prev || num(p.liquidity?.usd) > num(prev.liquidity?.usd)) out.set(mint, p);
    }
  }));
  return out;
}

async function rpc(url, method, params) {
  const r = await get(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (r.error) throw new Error(r.error.message);
  return r.result;
}

// copy-trade: net token change of each tracked wallet in its new transactions
async function walletSignals(state, wallets, rpcUrl, now) {
  const buys = new Map(), sells = new Set();
  for (const w of wallets) {
    try {
      const sigs = await rpc(rpcUrl, 'getSignaturesForAddress', [w, { limit: 10 }]);
      const last = state.walletSigs[w];
      state.walletSigs[w] = sigs[0]?.signature || last;
      if (!last) continue; // first sight: remember, never copy old history
      const fresh = [];
      for (const s of sigs) { if (s.signature === last) break; if (!s.err) fresh.push(s); }
      for (const s of fresh.slice(0, 5)) {
        if (s.blockTime && now / 1000 - s.blockTime > 180) continue; // older than 3 min = too late to copy
        const tx = await rpc(rpcUrl, 'getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
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

// ---------- desk chat + counters ----------
function say(state, agent, text, extra = {}) {
  state.feed.push({ ts: Date.now(), agent, text, ...extra });
}
function bump(today, agent, n = 1) {
  today.agents[agent] = (today.agents[agent] || 0) + n;
}
function dayBucket(state, now) {
  const t = (state.days[day(now)] ||= { scanned: 0, entered: 0, rejects: {} });
  t.agents ||= {};
  return t;
}

// ---------- one tick of the desk ----------
export async function tick(state, cfg, now = Date.now(), env = {}) {
  const fee = cfg.costs.feePctPerSide, fixed = cfg.costs.fixedUsdPerSide || 0;
  const today = dayBucket(state, now);
  const mark = (a) => { state.pulse[a] = now; };
  state.shadow ||= [];
  const { buys, sells } = cfg.copy.wallets.length && env.rpcUrl
    ? await walletSignals(state, cfg.copy.wallets, env.rpcUrl, now) : { buys: new Map(), sells: new Set() };

  // Guard first: open positions are the money at risk. Shadow book rides the same request.
  const watching = state.shadow.filter((s) => !s.done);
  if (state.positions.length || watching.length) {
    if (state.positions.length) mark('guard');
    const held = await pairsFor([...new Set([...state.positions.map((p) => p.mint), ...watching.map((s) => s.mint)])]);
    trackShadow(watching, held, now, cfg);
    for (const pos of [...state.positions]) {
      const p = held.get(pos.mint);
      if (sells.has(pos.mint)) pos.walletSold = true;
      const price = num(p?.priceUsd), liq = num(p?.liquidity?.usd);
      if (!p || !(price > 0)) {
        // a DexScreener outage is not a rug: only count misses when the request itself worked
        if (!held.failed && ++pos.missing >= cfg.exit.missingTicks) closePos(state, pos, 0, 'pair vanished (rug)', now, cfg, today);
        continue;
      }
      pos.missing = 0;
      pos.lastPrice = price; pos.lastLiq = liq;
      if (price > pos.peak) pos.peak = price;
      if (pos.tp1Done) pos.stop = Math.max(pos.stop, pos.peak * (1 - cfg.exit.trailPct));
      const d = exitDecision(pos, price, liq, now, cfg.exit);
      if (d.act === 'close') closePos(state, pos, sellFill(pos.qty, price, liq, fee, fixed), d.why, now, cfg, today);
      else if (d.act === 'partial') {
        const q = pos.qty * cfg.exit.tp1SellFraction;
        const got = sellFill(q, price, liq, fee, fixed);
        pos.qty -= q; pos.proceedsUsd += got; state.cashUsd += got;
        pos.tp1Done = true; pos.stop = Math.max(pos.entryPrice, pos.peak * (1 - cfg.exit.trailPct)); // never give back the win
        pos.events.push({ ts: now, what: d.why, price, usd: +got.toFixed(2) });
        bump(today, 'guard');
        say(state, 'guard', `${pos.symbol}: prodao pola na +${((price / pos.entryPrice - 1) * 100).toFixed(0)}%, stop podignut na ulaz`, { mint: pos.mint, tone: 'up' });
      }
    }
  }

  checkRun(state, cfg, now, today);

  // Scout
  mark('scout');
  const heldSet = new Set(state.positions.map((p) => p.mint));
  const found = await discover();
  const mints = [...new Set([...found, ...buys.keys()])].filter((m) => !heldSet.has(m) && !(state.cooldown[m] > now));
  const pairs = await pairsFor(mints);
  bump(today, 'scout', pairs.size);
  today.scanned += pairs.size;
  const live = [...pairs.values()].filter((p) => num(p.liquidity?.usd) > 0).sort((a, b) => num(b.volume?.h1) - num(a.volume?.h1)).slice(0, 14);
  if (live.length) state.ticker = live.map((p) => ({ s: p.baseToken.symbol, ch: num(p.priceChange?.m5), mc: Math.round(num(p.marketCap || p.fdv)) }));

  // Filter
  const picks = [];
  for (const [mint, p] of pairs) {
    const copied = buys.has(mint);
    const e = copied ? { ...cfg.entry, ...cfg.copy.relaxedEntry } : cfg.entry;
    const why = entryReject(p, now, e);
    if (why) {
      today.rejects[why] = (today.rejects[why] || 0) + 1;
      // near miss: would the old, looser rules have bought it? Track it to see if tightening was right.
      if (cfg.shadow && !entryReject(p, now, { ...e, ...cfg.shadow.baseline })) shadowAdd(state, p, `filter: ${why}`, now, cfg);
      continue;
    }
    picks.push({ mint, p, copied, s: score(p) + (copied ? 10 : 0) });
  }
  if (picks.length) { mark('filter'); bump(today, 'filter', picks.length); }
  picks.sort((a, b) => b.s - a.s);

  // Analyst -> Skeptic -> Sniper, best candidates first, only while there is room
  for (const { mint, p, copied } of picks) {
    if (state.positions.length >= cfg.maxOpen) { shadowAdd(state, p, 'nema mesta', now, cfg); continue; }
    const sym = p.baseToken.symbol;
    let c = state.rug[mint];
    if (!c || now - c.ts > 30 * MIN) {
      mark('analyst');
      try {
        const a = analyze(await get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`));
        const veto = skepticVeto(a, p, cfg.skeptic);
        c = state.rug[mint] = { ts: now, a, veto };
        bump(today, 'analyst');
        say(state, 'analyst', `${sym}: ${a.holders} holdera, top 10 drži ${a.top10}%, LP ${a.lpLocked}% zaključan`, { mint });
        state.radar.push({ mint, s: sym, risk: +riskOf(a, !!veto).toFixed(2), ok: !veto, ts: now });
      } catch {
        continue; // unknown = unsafe; retried next tick
      }
    }
    mark('skeptic');
    if (c.veto) {
      bump(today, 'blocked');
      today.rejects['skeptic veto'] = (today.rejects['skeptic veto'] || 0) + 1;
      state.cooldown[mint] = now + 30 * MIN; // do not re-argue the same token every tick
      shadowAdd(state, p, `veto: ${c.veto.replace(/[\d.]+/g, 'N')}`, now, cfg);
      say(state, 'skeptic', `${sym}: blokiram. ${c.veto}.`, { mint, tone: 'down', veto: true });
      continue;
    }
    bump(today, 'skeptic');
    say(state, 'skeptic', `${sym}: nemam primedbu.`, { mint });

    mark('sniper');
    const minUsd = cfg.minTradeUsd || 5;
    const usd = Math.min(state.cashUsd, Math.max(minUsd, equity(state) * (copied ? cfg.copyPositionPct : cfg.positionPct)));
    if (usd < minUsd) { shadowAdd(state, p, 'nema keša', now, cfg); break; }
    const price = num(p.priceUsd), liq = num(p.liquidity?.usd);
    const qty = buyFill(usd, price, liq, fee, fixed);
    shadowAdd(state, p, 'kupljeno', now, cfg);
    state.cashUsd -= usd;
    state.positions.push({
      mint, symbol: sym, name: p.baseToken.name, url: p.url, img: p.info?.imageUrl || '',
      source: copied ? 'copy' : 'momentum', wallet: copied ? buys.get(mint) : undefined,
      entryTs: now, entryPrice: price, costUsd: usd, qty, proceedsUsd: 0,
      peak: price, stop: price * (1 + cfg.exit.stopLossPct), tp1Done: false,
      entryLiq: liq, lastPrice: price, lastLiq: liq, missing: 0,
      features: features(p, now), analysis: c.a, events: [{ ts: now, what: 'buy', price, usd: +usd.toFixed(2) }],
    });
    today.entered++;
    bump(today, 'sniper');
    say(state, 'sniper', `${sym}: kupljeno $${usd.toFixed(2)}, stop ${(cfg.exit.stopLossPct * 100).toFixed(0)}%`, { mint, tone: 'up' });
  }
  state.lastRun = now;
}

function closePos(state, pos, proceeds, why, now, cfg, today) {
  state.cashUsd += proceeds;
  const total = pos.proceedsUsd + proceeds;
  state.positions = state.positions.filter((p) => p !== pos);
  state.cooldown[pos.mint] = now + cfg.cooldownMin * MIN;
  const pnl = total - pos.costUsd, pct = (total / pos.costUsd - 1) * 100;
  state.closed.push({
    mint: pos.mint, symbol: pos.symbol, name: pos.name, url: pos.url, img: pos.img, source: pos.source,
    entryTs: pos.entryTs, exitTs: now, entryPrice: pos.entryPrice, exitPrice: pos.lastPrice,
    costUsd: +pos.costUsd.toFixed(2), proceedsUsd: +total.toFixed(2),
    pnlUsd: +pnl.toFixed(2), pnlPct: +pct.toFixed(1),
    peakPct: +((pos.peak / pos.entryPrice - 1) * 100).toFixed(1), reason: why, features: pos.features, analysis: pos.analysis,
    run: state.run?.n,
  });
  if (today) bump(today, 'guard');
  say(state, 'guard', `${pos.symbol}: izlaz (${why}), ${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(2)}`, { mint: pos.mint, tone: pnl >= 0 ? 'up' : 'down' });
}

// ---------- runs: start small, hit the goal or bust, then start again and learn ----------
export function checkRun(state, cfg, now, today) {
  const r = state.run;
  if (!r) return null;
  const eq = equity(state);
  let result = null;
  if (eq >= r.goalUsd) {
    // cash out at the goal: a target only counts once it is sold
    for (const pos of [...state.positions]) closePos(state, pos, sellFill(pos.qty, pos.lastPrice, pos.lastLiq, cfg.costs.feePctPerSide, cfg.costs.fixedUsdPerSide || 0), 'cilj: isplata', now, cfg, today);
    result = 'cilj';
  } else if (!state.positions.length && state.cashUsd < (cfg.minTradeUsd || 5)) result = 'bust';
  if (!result) return null;
  const mine = state.closed.filter((t) => t.run === r.n);
  state.runs.push({
    n: r.n, result, startUsd: r.startUsd, endUsd: +state.cashUsd.toFixed(2), peakUsd: +Math.max(r.peakUsd, state.cashUsd).toFixed(2),
    trades: mine.length, wins: mine.filter((t) => t.pnlUsd > 0).length, startedAt: r.startedAt, endedAt: now,
  });
  say(state, 'guard', result === 'cilj'
    ? `Run #${r.n}: CILJ! $${r.startUsd} → $${state.cashUsd.toFixed(2)}. Novi run od $${cfg.startBalanceUsd}.`
    : `Run #${r.n} izgubljen ($${state.cashUsd.toFixed(2)} ostalo). Učimo iz grešaka, novi run od $${cfg.startBalanceUsd}.`, { tone: result === 'cilj' ? 'up' : 'down' });
  state.run = { n: r.n + 1, startUsd: cfg.startBalanceUsd, goalUsd: cfg.goalUsd, startedAt: now, peakUsd: cfg.startBalanceUsd };
  state.cashUsd = cfg.startBalanceUsd;
  state.startBalanceUsd = cfg.startBalanceUsd;
  state.startedAt = now;
  state.equity = [[now, cfg.startBalanceUsd]];
  return result;
}

// ---------- shadow book: what happened to every token we bought, vetoed or nearly bought ----------
function shadowAdd(state, p, why, now, cfg) {
  const sh = cfg.shadow;
  const mint = p.baseToken?.address, p0 = num(p.priceUsd);
  if (!sh || !(p0 > 0) || state.shadow.some((s) => s.mint === mint && !s.done)) return;
  if (state.shadow.filter((s) => !s.done).length >= sh.maxOpen) return;
  state.shadow.push({ mint, s: p.baseToken.symbol, why, ts: now, p0, hi: p0, lo: p0, last: p0, first: null, done: false, f: features(p, now) });
}

// first touch decides: did it reach our take-profit before our stop?
export function trackShadow(list, held, now, cfg) {
  for (const s of list) {
    const price = num(held.get(s.mint)?.priceUsd);
    if (price > 0) {
      s.last = price; s.hi = Math.max(s.hi, price); s.lo = Math.min(s.lo, price);
      const g = price / s.p0 - 1;
      if (!s.first && g >= cfg.exit.tp1Pct) s.first = 'win';
      if (!s.first && g <= cfg.exit.stopLossPct) s.first = 'loss';
    }
    if (now - s.ts >= cfg.shadow.windowMin * MIN) s.done = true;
  }
}

export function equity(state) {
  return state.cashUsd + state.positions.reduce((s, p) => s + p.qty * (p.lastPrice || p.entryPrice), 0);
}

// keep the state small enough to poll from a phone
export function finish(state, now = Date.now()) {
  const last = state.equity.at(-1);
  if (!last || now - last[0] >= MIN) state.equity.push([now, +equity(state).toFixed(2)]);
  else last[1] = +equity(state).toFixed(2);
  const thin = [];
  for (const pt of state.equity) {
    const prev = thin.at(-1);
    if (now - pt[0] > 24 * 60 * MIN && prev && Math.floor(prev[0] / (15 * MIN)) === Math.floor(pt[0] / (15 * MIN))) { thin[thin.length - 1] = pt; continue; }
    thin.push(pt);
  }
  state.equity = thin.filter(([t]) => now - t < 30 * 24 * 60 * MIN);
  for (const [m, t] of Object.entries(state.cooldown)) if (t < now) delete state.cooldown[m];
  for (const [m, c] of Object.entries(state.rug)) if (now - c.ts > 2 * 60 * MIN) delete state.rug[m];
  state.feed = state.feed.slice(-80);
  state.radar = state.radar.slice(-24);
  state.closed = state.closed.slice(-500);
  if (state.run) state.run.peakUsd = +Math.max(state.run.peakUsd, equity(state)).toFixed(2);
  if (state.shadow) state.shadow = state.shadow.slice(-400);
  if (state.runs) state.runs = state.runs.slice(-100);
  const keep = Object.keys(state.days).sort().slice(-30);
  state.days = Object.fromEntries(keep.map((k) => [k, state.days[k]]));
  return state;
}
