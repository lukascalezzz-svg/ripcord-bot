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
