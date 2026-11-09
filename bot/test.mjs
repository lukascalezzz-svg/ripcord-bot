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
  // DACAT 2026-11-08: top10 19.8% of $100k mcap vs $24k pool, LP burned, rugged in 6 min
  assert.match(skepticVeto({ ...a, top10: 19.8 }, { ...good, liquidity: { usd: 23_894 }, marketCap: 100_656 }, cfg.skeptic), /isprazni pul/);
});

test('filter: one-sided bot buying is rejected (DACAT 624 buys vs 79 sells)', () => {
  assert.equal(entryReject({ ...good, txns: { ...good.txns, m5: { buys: 624, sells: 79 } } }, now, cfg.entry), 'bot buying 5m');
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
const c20 = { ...cfg, maxOpen: 1, entry: { ...cfg.entry, confirmMin: 0 } };

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

test('tick: two-look entry waits, buys only if the price held', async () => {
  const c = { ...cfg, maxOpen: 1 };
  const s = freshState(c, now);
  market(0.001);
  await tick(s, c, now);
  assert.equal(s.positions.length, 0, 'never buys on the first look');
  assert.equal(s.shadow[0].why, 'prvi pogled');
  await tick(s, c, now + 60_000);
  assert.equal(s.positions.length, 0, 'still waiting');
  market(0.00105);
  await tick(s, c, now + 121_000);
  assert.equal(s.positions.length, 1, 'held +5% for 2 min: buy');
  assert.equal(s.positions[0].entryPrice, 0.00105);

  const d = freshState(c, now);
  market(0.001);
  await tick(d, c, now);
  market(0.0009);
  await tick(d, c, now + 121_000);
  assert.equal(d.positions.length, 0, 'fell 10% while we waited: skip');
  assert.equal(d.days[Object.keys(d.days)[0]].rejects['no confirmation'], 1);
  assert.ok(d.cooldown[MINT] > now);
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

// ---------- live mirror: real-money path against a fake chain (no network) ----------
import { b58, unb58, newWallet, signer, signTx, gate, mirror } from './live.mjs';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const liveCfg = { ...cfg, live: { on: true, capUsd: 20, gateFrom: 0, gateTrades: 50, gatePf: 1.2 } };
const proven = (s) => { s.closed = Array.from({ length: 50 }, (_, i) => ({ mint: 'old' + i, symbol: 'OLD', exitTs: now - 1000, pnlUsd: i % 3 ? 1 : -1 })); return s; };
const fakeTx = (payer) => Uint8Array.from([1, ...new Uint8Array(64), 0x80, 1, 0, 1, 1, ...payer]);

// 1 SOL = $100; a buy mints 1000 tokens per lamport, a sell pays them back times `mult`
function chain(w, sol = 1) {
  const c = { lamports: sol * 1e9, tokens: new Map(), sent: 0, mult: 1, next: null };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    let body;
    if (u.includes('/quote')) {
      const q = new URL(u).searchParams;
      body = { inputMint: q.get('inputMint'), outputMint: q.get('outputMint'), inAmount: q.get('amount'), outAmount: q.get('outputMint') === USDC ? '100000000' : '1' };
    } else if (u.includes('/swap')) {
      c.next = JSON.parse(init.body).quoteResponse;
      body = { swapTransaction: Buffer.from(fakeTx(w.pub)).toString('base64') };
    } else {
      const { method, params } = JSON.parse(init.body);
      if (method === 'getBalance') body = { result: { value: c.lamports } };
      else if (method === 'getTokenAccountsByOwner') body = { result: { value: params[1].programId.startsWith('Tokenkeg') ? [...c.tokens].map(([mint, raw]) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { amount: String(raw) } } } } } })) : [] } };
      else if (method === 'sendTransaction') {
        const q = c.next, amt = BigInt(q.inAmount);
        if (q.inputMint === SOL) { c.lamports -= Number(amt) + 5000; c.tokens.set(q.outputMint, (c.tokens.get(q.outputMint) || 0n) + amt * 1000n); }
        else { c.tokens.set(q.inputMint, c.tokens.get(q.inputMint) - amt); c.lamports += (Number(amt) / 1000) * c.mult - 5000; }
        c.sent++;
        body = { result: 'sig' + c.sent };
      } else if (method === 'getSignatureStatuses') body = { result: { value: [{ confirmationStatus: 'confirmed' }] } };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, ...body }) };
  };
  return c;
}

test('wallet: base58 round trip, and we only sign transactions we alone pay for', async () => {
  const { address, secret } = await newWallet();
  const w = await signer(secret);
  assert.equal(w.address, address);
  assert.equal(b58(unb58('11' + address)), '11' + address, 'leading zero bytes survive');
  const signed = await signTx(fakeTx(w.pub), w);
  const pub = await crypto.subtle.importKey('raw', w.pub, 'Ed25519', false, ['verify']);
  assert.ok(await crypto.subtle.verify('Ed25519', pub, signed.slice(1, 65), signed.slice(65)));
  await assert.rejects(signTx(fakeTx(new Uint8Array(32)), w), /fee payer/);
  await assert.rejects(signTx(Uint8Array.from([2, ...fakeTx(w.pub).slice(1)]), w), /other signers/);
});

test('gate: locked until 50 paper trades in profit, and locks again when paper turns red', () => {
  const s = freshState(cfg, now);
  assert.equal(gate(s, liveCfg).ok, false);
  proven(s);
  assert.equal(gate(s, liveCfg).ok, true);
  assert.equal(gate(s, { ...liveCfg, live: { ...liveCfg.live, gateFrom: now } }).trades, 0, 'only trades after the rule change count');
  s.closed.push({ exitTs: now, pnlUsd: -30 });
  assert.equal(gate(s, liveCfg).ok, false);
});

test('mirror: locked gate or switch off never spends; open gate copies buy, half and close; kill switch sells', async () => {
  const { secret } = await newWallet();
  const w = await signer(secret);
  const paper = () => ({ mint: MINT, symbol: 'TST', entryTs: now, tp1Done: false });

  let c = chain(w), s = freshState(cfg, now);
  s.positions.push(paper());
  await mirror(s, liveCfg, secret, 'http://rpc', now);
  assert.equal(c.sent, 0, 'gate locked: no transaction');
  assert.equal(s.live.address, w.address);
  assert.equal(s.live.usd, 100);
  await mirror(proven(s), { ...liveCfg, live: { ...liveCfg.live, on: false } }, secret, 'http://rpc', now + 61_000);
  assert.equal(c.sent, 0, 'switch off: no transaction');

  c = chain(w); s = proven(freshState(cfg, now));
  s.positions.push(paper());
  await mirror(s, liveCfg, secret, 'http://rpc', now);
  const lp = s.live.pos[MINT];
  assert.ok(lp && !lp.pending && Math.abs(lp.costUsd - 6) < 0.01, `buys 30% of the $20 cap, not of the $100 wallet: ${lp?.costUsd}`);
  await mirror(s, liveCfg, secret, 'http://rpc', now + 15_000);
  assert.equal(c.sent, 1, 'no double buy');

  c.mult = 1.5; s.positions[0].tp1Done = true;
  await mirror(s, liveCfg, secret, 'http://rpc', now + 30_000);
  assert.ok(lp.half && Math.abs(lp.gotUsd - 6 * cfg.exit.tp1SellFraction * 1.5) < 0.01, `take-profit part sold at +50%: ${lp.gotUsd}`);
  s.positions = [];
  await mirror(s, liveCfg, secret, 'http://rpc', now + 45_000);
  assert.deepEqual(s.live.pos, {});
  assert.ok(Math.abs(s.live.pnlUsd - 3) < 0.01, `pnl ${s.live.pnlUsd}`);
  assert.equal(c.tokens.get(MINT), 0n);

  // late entry is never chased
  s.positions.push({ ...paper(), entryTs: now - 60_000 });
  await mirror(s, liveCfg, secret, 'http://rpc', now + 60_000);
  assert.equal(c.sent, 3);

  // kill switch with money in a token: everything is sold
  s.positions = [{ ...paper(), entryTs: now + 90_000 }];
  await mirror(s, liveCfg, secret, 'http://rpc', now + 90_000);
  assert.ok(s.live.pos[MINT]);
  await mirror(s, { ...liveCfg, live: { ...liveCfg.live, on: false } }, secret, 'http://rpc', now + 105_000);
  assert.deepEqual(s.live.pos, {});
  assert.equal(c.tokens.get(MINT), 0n);
});

// ---------- tournament: several tactics, one market, shared requests ----------
import { runAll } from './run.mjs';
import { followed } from './live.mjs';

test('tournament: each bot keeps its own book, extra bots cost no extra requests, real money can follow a lab bot', async () => {
  const base = { ...cfg, maxOpen: 1, entry: { ...cfg.entry, confirmMin: 0 } };
  const one = { ...base, lab: {} };
  const many = { ...base, lab: { fast: { label: 'Fast', about: 'x', exit: { tp1Pct: 0.1 } }, never: { label: 'Never', entry: { minLiquidityUsd: 1e12 } } } };
  let calls = 0;
  const counted = () => { market(0.001); const f = globalThis.fetch; globalThis.fetch = (...a) => { calls++; return f(...a); }; };

  counted(); const solo = freshState(one, now); await runAll(solo, one, now);
  const soloCalls = calls; calls = 0;
  counted(); const s = freshState(many, now); await runAll(s, many, now);
  assert.equal(calls, soloCalls, 'two more bots, same number of requests');
  assert.equal(s.positions.length, 1, 'house desk bought');
  assert.equal(s.lab.fast.positions.length, 1, 'challenger bought into its own book');
  assert.equal(s.lab.never.positions.length, 0, 'its own filter applies');
  assert.equal(s.cashUsd, 14); assert.equal(s.lab.fast.cashUsd, 14); assert.equal(s.lab.never.cashUsd, 20);
  assert.deepEqual(s.board.map((b) => b.k), ['main', 'fast', 'never']);
  assert.equal(s.board[1].label, 'Fast');
  assert.equal(s.lab.fast.rug, undefined, 'shared caches are not stored once per bot');

  market(0.00112);
  await runAll(s, many, now + 60_000);
  assert.ok(s.lab.fast.positions[0].tp1Done && !s.positions[0].tp1Done, 'own exit rules: +12% takes profit only for the bot with tp1 at +10%');

  assert.equal(followed(s, many).view, s);
  const f = followed(s, { ...many, live: { follow: 'fast' } });
  assert.equal(f.view.positions, s.lab.fast.positions);
  assert.equal(f.view.live, s.live);
  assert.equal(f.vcfg.exit.tp1Pct, 0.1);
  assert.equal(s.live.follow, 'fast');
  assert.equal(followed(s, { ...many, live: { follow: 'gone' } }).view, s, 'unknown name falls back to the house desk');

  await runAll(s, one, now + 75_000);
  assert.deepEqual(s.lab, {}, 'a bot removed from config is retired');
});

test('second-wave filter: needs an earlier pump', () => {
  const e = { ...cfg.entry, ...cfg.lab.talas.entry };
  const dip = { ...good, pairCreatedAt: now - 300 * 60_000, priceChange: { m5: 4, h1: -20, h6: 120 }, txns: { m5: { buys: 90, sells: 40 }, h1: { buys: 400, sells: 500 } } };
  assert.equal(entryReject(dip, now, e), null);
  assert.equal(entryReject({ ...dip, priceChange: { m5: 4, h1: -20, h6: 10 } }, now, e), 'no earlier pump');
  assert.equal(entryReject({ ...dip, priceChange: { m5: 4, h1: 30, h6: 120 } }, now, e), 'already pumped');
});
