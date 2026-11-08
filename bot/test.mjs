import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { buyFill, sellFill, entryReject, exitDecision, freshState, equity } from './run.mjs';

const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
const now = 1_800_000_000_000;

test('round trip at flat price loses fees + impact, never gains', () => {
  const qty = buyFill(100, 0.001, 50_000, 0.01);
  const back = sellFill(qty, 0.001, 50_000, 0.01);
  assert.ok(back < 98 && back > 97, `got ${back}`); // ~2% fees + ~0.8% impact
});

test('thin pool punishes size', () => {
  assert.ok(sellFill(buyFill(100, 1, 2_000, 0), 1, 2_000, 0) < 85);
});

const good = {
  liquidity: { usd: 60_000 }, marketCap: 400_000, pairCreatedAt: now - 120 * 60_000,
  txns: { m5: { buys: 120, sells: 30 }, h1: { buys: 500, sells: 300 } },
  priceChange: { m5: 6, h1: 40 }, volume: { h1: 90_000 }, priceUsd: '0.001',
};

test('entry: healthy momentum passes, bad setups get a reason', () => {
  assert.equal(entryReject(good, now, cfg.entry), null);
  assert.equal(entryReject({ ...good, liquidity: {} }, now, cfg.entry), 'no pool liquidity');
  assert.equal(entryReject({ ...good, priceChange: { m5: 35, h1: 40 } }, now, cfg.entry), 'candle too vertical');
  assert.equal(entryReject({ ...good, pairCreatedAt: now - 5 * 60_000 }, now, cfg.entry), 'too new');
});

const pos = () => ({ entryPrice: 1, entryTs: now, stop: 0.82, peak: 1, tp1Done: false, entryLiq: 60_000 });

test('exit rules', () => {
  const x = cfg.exit;
  assert.equal(exitDecision(pos(), 0.8, 60_000, now, x).why, 'stop loss');
  assert.equal(exitDecision(pos(), 1.45, 60_000, now, x).act, 'partial');
  assert.equal(exitDecision(pos(), 1.0, 20_000, now, x).why, 'liquidity pulled');
  assert.equal(exitDecision(pos(), 1.02, 60_000, now + 91 * 60_000, x).why, 'dead coin');
  assert.equal(exitDecision(pos(), 4.5, 60_000, now, x).why, 'moonshot take profit');
  assert.equal(exitDecision({ ...pos(), tp1Done: true, stop: 1.1 }, 1.05, 60_000, now, x).why, 'trailing stop');
  assert.equal(exitDecision(pos(), 1.1, 60_000, now + 10 * 60_000, x).act, 'none');
});

test('fresh state equity = start balance', () => {
  assert.equal(equity(freshState(cfg)), cfg.startBalanceUsd);
});

import { analyze, skepticVeto, finish } from './run.mjs';

const report = {
  totalHolders: 900, graphInsidersDetected: 0, creatorTokens: [], mintAuthority: null, freezeAuthority: null,
  knownAccounts: { POOL: { name: 'Pump AMM', type: 'AMM' } },
  markets: [{ pubkey: 'MKT', lp: { lpLockedPct: 100 } }],
  topHolders: [{ owner: 'POOL', address: 'a', pct: 80 }, { owner: 'w1', address: 'b', pct: 4 }, { owner: 'w2', address: 'c', pct: 3 }],
  risks: [{ name: 'Low Liquidity', level: 'danger' }],
};

test('analyst ignores the pool and liquidity warnings; skeptic passes a clean token', () => {
  const a = analyze(report);
  assert.equal(a.top10, 7);
  assert.equal(a.topOne, 4);
  assert.deepEqual(a.dangers, []);
  assert.equal(skepticVeto(a, good, cfg.skeptic), null);
});

test('skeptic vetoes the classic rug setups', () => {
  const a = analyze(report);
  assert.match(skepticVeto({ ...a, mintAuth: true }, good, cfg.skeptic), /štampa/);
  assert.match(skepticVeto({ ...a, topOne: 22 }, good, cfg.skeptic), /22%/);
  assert.match(skepticVeto({ ...a, lpLocked: 0 }, good, cfg.skeptic), /LP/);
  assert.match(skepticVeto({ ...a, holders: 40 }, good, cfg.skeptic), /40 holdera/);
  assert.match(skepticVeto(a, { ...good, liquidity: { usd: 5_000 }, marketCap: 1_000_000 }, cfg.skeptic), /tanka/);
});

test('finish keeps state small', () => {
  const s = freshState(cfg, now);
  s.feed = Array.from({ length: 200 }, (_, i) => ({ ts: i }));
  s.equity = Array.from({ length: 3000 }, (_, i) => [now - (3000 - i) * 60_000, 1000]);
  finish(s, now);
  assert.equal(s.feed.length, 80);
  assert.ok(s.equity.length < 1600, `equity ${s.equity.length}`);
});

// ---------- tick() money flow with a fake DexScreener / RugCheck ----------
import { tick, checkRun } from './run.mjs';

const MINT = 'TokenMint1111111111111111111111111111111pump';
const SOL = 'So11111111111111111111111111111111111111112';
const clean = { ...report, risks: [] };
function market(price, { down = false } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (down && u.includes('/tokens/v1/')) return { ok: false, status: 503, json: async () => ({}) };
    let body = [];
    if (u.includes('token-profiles')) body = [{ chainId: 'solana', tokenAddress: MINT }];
    else if (u.includes('/tokens/v1/')) body = [{ ...good, pairCreatedAt: now - 120 * 60_000, priceUsd: String(price), baseToken: { address: MINT, symbol: 'TST', name: 'Test' }, quoteToken: { address: SOL } }];
    else if (u.includes('rugcheck')) body = clean;
    return { ok: true, status: 200, json: async () => body };
  };
}
const c20 = { ...cfg, maxOpen: 1 };

test('tick: buys with $20 desk, outage does not close, take profit then trail', async () => {
  const s = freshState(c20, now);
  market(0.001);
  await tick(s, c20, now);
  assert.equal(s.positions.length, 1, 'bought');
  const pos = s.positions[0];
  assert.ok(Math.abs(pos.costUsd - 6) < 0.01, `30% of $20, got ${pos.costUsd}`);
  assert.ok(Math.abs(s.cashUsd - 14) < 0.01);
  assert.equal(s.shadow[0].why, 'kupljeno');

  market(0.001, { down: true });
  for (let i = 0; i < 15; i++) await tick(s, c20, now + (i + 1) * 15_000);
  assert.equal(s.positions.length, 1, 'DexScreener outage must not write the position off');
  assert.equal(pos.missing, 0);

  market(0.0015);
  await tick(s, c20, now + 5 * 60_000);
  assert.ok(pos.tp1Done, 'sold half at +50%');
  assert.ok(pos.stop >= pos.entryPrice, 'stop moved to break-even or better');

  market(0.0011);
  await tick(s, c20, now + 6 * 60_000);
  assert.equal(s.positions.length, 0);
  const t = s.closed.at(-1);
  assert.equal(t.reason, 'trailing stop');
  assert.ok(t.pnlUsd > 0, `half at +50% then exit above entry is a win, got ${t.pnlUsd}`);
  assert.equal(t.run, 1);
  assert.equal(s.shadow[0].first, 'win');
});

test('tick: zero price never buys', async () => {
  const s = freshState(c20, now);
  market(0);
  await tick(s, c20, now);
  assert.equal(s.positions.length, 0);
});

test('runs: bust restarts at $20, goal cashes out and restarts', () => {
  const s = freshState(cfg, now);
  s.cashUsd = 1.2;
  assert.equal(checkRun(s, cfg, now), 'bust');
  assert.equal(s.run.n, 2);
  assert.equal(s.cashUsd, 20);
  assert.equal(s.runs[0].result, 'bust');

  s.cashUsd = 10;
  s.positions.push({ mint: MINT, symbol: 'TST', qty: 1000, lastPrice: 0.2, lastLiq: 1e6, costUsd: 10, proceedsUsd: 0, entryPrice: 0.01, peak: 0.2, entryTs: now });
  assert.equal(checkRun(s, cfg, now + 1), 'cilj');
  assert.equal(s.positions.length, 0);
  assert.ok(s.runs[1].endUsd >= 150, `cashed out ${s.runs[1].endUsd}`);
  assert.equal(s.run.n, 3);
  assert.equal(s.cashUsd, 20);
});

test('fixed network cost makes tiny trades honest', () => {
  const back = sellFill(buyFill(2, 1, 1e6, 0.0125, 0.05), 1, 1e6, 0.0125, 0.05);
  assert.ok(back < 1.86 && back > 1.84, `$2 round trip should cost ~7.5%, got ${back}`);
});
