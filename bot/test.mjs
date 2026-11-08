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
  txns: { m5: { buys: 60, sells: 30 }, h1: { buys: 500, sells: 300 } },
  priceChange: { m5: 6, h1: 40 }, volume: { h1: 90_000 },
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
