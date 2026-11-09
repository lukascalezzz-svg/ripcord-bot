// Pull 1-minute candles around every decision the desk made (bought, vetoed, near miss) so rules can be backtested.
import fs from 'node:fs';
// node bot/candles.mjs  (slow: GeckoTerminal's free API allows only a few calls a minute; ~40 min for 100 decisions)
const dir = new URL('../data/', import.meta.url);
const U = 'https://xgwazrawzivaqoiwwysl.supabase.co/rest/v1';
const H = { apikey: 'sb_publishable_rJinet3DRSjTdXP2vb9HEA_j6mqlvIx' };
const s = (await (await fetch(`${U}/rc_state?select=state`, { headers: H })).json())[0].state;
const QUOTES = new Set(['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (url) => {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (r?.ok) return r.json();
    if (r && r.status !== 429 && r.status < 500) return null;
    await sleep(25000);
  }
  return null;
};

const items = [
  ...s.shadow.filter((x) => x.done || x.first).map((x) => ({ mint: x.mint, sym: x.s, ts: x.ts, p0: x.p0, why: x.why, f: x.f, first: x.first })),
  ...s.closed.map((t) => ({ mint: t.mint, sym: t.symbol, ts: t.entryTs, p0: t.entryPrice, why: 'TRADE', f: t.features, pnlPct: t.pnlPct, reason: t.reason })),
];
const mints = [...new Set(items.map((i) => i.mint))];
const pool = {};
for (let i = 0; i < mints.length; i += 30) {
  const pairs = (await get(`https://api.dexscreener.com/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`)) || [];
  for (const p of pairs) {
    const m = p.baseToken?.address;
    if (!QUOTES.has(p.quoteToken?.address)) continue;
    if (!pool[m] || (p.liquidity?.usd || 0) > pool[m].liq) pool[m] = { addr: p.pairAddress, liq: p.liquidity?.usd || 0 };
  }
}
console.log('items', items.length, 'mints', mints.length, 'pools found', Object.keys(pool).length);
const out = [];
for (const it of items) {
  const p = pool[it.mint];
  if (!p) { out.push({ ...it, candles: null }); continue; }
  const before = Math.floor(it.ts / 1000) + 125 * 60;
  const j = await get(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${p.addr}/ohlcv/minute?aggregate=1&before_timestamp=${before}&limit=150&currency=usd`);
  const c = j?.data?.attributes?.ohlcv_list || null;
  out.push({ ...it, candles: c && c.map((k) => k.slice(0, 6)).reverse() });
  fs.writeFileSync(new URL('candles.json', dir), JSON.stringify(out));
  await sleep(2600);
}
console.log('done', out.length, 'with candles', out.filter((o) => o.candles?.length).length);
