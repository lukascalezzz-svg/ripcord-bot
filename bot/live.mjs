// Real-money mirror of the paper desk. The paper desk stays the brain; this only copies its
// buys and sells into the bot's own wallet, and only while the proof gate is open.
// Zero dependencies: WebCrypto Ed25519 + Solana JSON-RPC + Jupiter. Runs in Node and Deno.

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUP = 'https://lite-api.jup.ag/swap/v1';
export const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PKCS8 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
const FEE_RESERVE_SOL = 0.01; // never spend the SOL that pays for the exit
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function b58(u8) {
  let n = 0n;
  for (const b of u8) n = (n << 8n) | BigInt(b);
  let s = '';
  for (; n > 0n; n /= 58n) s = ALPHA[Number(n % 58n)] + s;
  for (const b of u8) { if (b) break; s = '1' + s; }
  return s;
}
export function unb58(s) {
  let n = 0n;
  for (const c of s) { const i = ALPHA.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const out = [];
  for (; n > 0n; n >>= 8n) out.unshift(Number(n & 255n));
  for (const c of s) { if (c !== '1') break; out.unshift(0); }
  return Uint8Array.from(out);
}
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// secret = base58(seed + public key), the format Phantom imports
export async function newWallet() {
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const seed = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).slice(-32);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { address: b58(pub), secret: b58(Uint8Array.from([...seed, ...pub])) };
}
export async function signer(secret) {
  const raw = unb58(secret);
  if (raw.length !== 64) throw new Error('bad wallet secret');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from([...PKCS8, ...raw.slice(0, 32)]), 'Ed25519', false, ['sign']);
  return { address: b58(raw.slice(32)), pub: raw.slice(32), sign: async (msg) => new Uint8Array(await crypto.subtle.sign('Ed25519', key, msg)) };
}

async function http(url, body) {
  const r = await fetch(url, {
    ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 60)}`);
  return r.json();
}
export async function rpc(url, method, params = []) {
  const r = await http(url, { jsonrpc: '2.0', id: 1, method, params });
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}

// Sign a transaction someone else built, but only if we are its single signer and fee payer.
export async function signTx(tx, w) {
  if (tx[0] !== 1) throw new Error('tx wants other signers');
  const msg = tx.slice(65);
  const o = msg[0] & 0x80 ? 1 : 0; // v0 messages carry a version byte
  if (b58(msg.slice(o + 4, o + 36)) !== w.address) throw new Error('tx fee payer is not our wallet');
  const out = tx.slice();
  out.set(await w.sign(msg), 1);
  return out;
}

async function send(rpcUrl, tx) {
  const sig = await rpc(rpcUrl, 'sendTransaction', [b64(tx), { encoding: 'base64', maxRetries: 3 }]);
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const st = (await rpc(rpcUrl, 'getSignatureStatuses', [[sig]])).value[0];
    if (st?.err) throw new Error(`tx failed ${sig.slice(0, 8)}`);
    if (st && st.confirmationStatus !== 'processed') return sig;
  }
  throw new Error(`tx not confirmed ${sig.slice(0, 8)}`);
}

const lamportsOf = async (rpcUrl, addr) => (await rpc(rpcUrl, 'getBalance', [addr, { commitment: 'confirmed' }])).value;
// every token the wallet holds, mint -> raw amount (pump tokens live under either token program)
async function holdings(rpcUrl, addr) {
  const out = new Map();
  for (const programId of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
    const r = await rpc(rpcUrl, 'getTokenAccountsByOwner', [addr, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    for (const v of r.value) {
      const i = v.account.data.parsed.info, raw = BigInt(i.tokenAmount.amount);
      if (raw > 0n) out.set(i.mint, (out.get(i.mint) || 0n) + raw);
    }
  }
  return out;
}
const quote = (inMint, outMint, amount, bps) =>
  http(`${JUP}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${bps}&restrictIntermediateTokens=true`);

export async function swapTx(w, inMint, outMint, amount, bps) {
  const q = await quote(inMint, outMint, amount, bps);
  const { swapTransaction } = await http(`${JUP}/swap`, {
    quoteResponse: q, userPublicKey: w.address, dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 200_000, priorityLevel: 'high' } },
  });
  return signTx(unb64(swapTransaction), w);
}
// returns the wallet's real SOL change, fees included: the only number that cannot lie
async function swap(w, rpcUrl, inMint, outMint, amount, bps) {
  const before = await lamportsOf(rpcUrl, w.address);
  await send(rpcUrl, await swapTx(w, inMint, outMint, amount, bps));
  return ((await lamportsOf(rpcUrl, w.address)) - before) / 1e9;
}

// Proof gate: real money stays locked until the paper desk is in profit over enough trades.
// It also closes again by itself if paper slides back into a loss.
export function gate(state, cfg) {
  const g = cfg.live || {};
  const t = (state.closed || []).filter((x) => x.exitTs >= (g.gateFrom || 0));
  const win = t.reduce((a, x) => a + Math.max(x.pnlUsd, 0), 0), loss = t.reduce((a, x) => a + Math.max(-x.pnlUsd, 0), 0);
  const pf = loss ? win / loss : win ? 99 : 0;
  const need = g.gateTrades ?? 50, minPf = g.gatePf ?? 1.2;
  return { from: g.gateFrom || 0, trades: t.length, need, pnlUsd: +(win - loss).toFixed(2), pf: +pf.toFixed(2), minPf, ok: t.length >= need && win > loss && pf >= minPf };
}

// Which paper book real money copies: the house desk, or the lab bot named in config.live.follow.
export function followed(state, cfg) {
  const k = cfg.live?.follow, bot = k && state.lab?.[k], b = bot && cfg.lab?.[k];
  state.live ||= {};
  state.live.follow = b ? k : 'main';
  if (!b) return { view: state, vcfg: cfg };
  return { view: { live: state.live, positions: bot.positions, closed: bot.closed }, vcfg: { ...cfg, ...b, entry: { ...cfg.entry, ...b.entry }, exit: { ...cfg.exit, ...b.exit } } };
}

// One reconcile pass: make the wallet match the paper desk. Safe to repeat; a failed step is retried next tick.
export async function mirror(state, cfg, secret, rpcUrl = PUBLIC_RPC, now = Date.now()) {
  const L = (state.live ||= {});
  L.pos ||= {}; L.closed ||= []; L.pnlUsd ||= 0;
  const w = await signer(secret);
  L.address = w.address;
  L.gate = gate(state, cfg);
  L.capUsd = cfg.live?.capUsd ?? 20;
  L.on = !!cfg.live?.on;
  const want = L.on && L.gate.ok;
  L.active = want;
  const open = Object.keys(L.pos);
  if (!want && !open.length && now - (L.balTs || 0) < 60_000) return; // idle: balance once a minute is enough
  L.solUsd = Number((await quote(SOL, USDC, 1e9, 50)).outAmount) / 1e6;
  const refresh = async () => { L.sol = (await lamportsOf(rpcUrl, w.address)) / 1e9; L.usd = +(L.sol * L.solUsd).toFixed(2); L.balTs = now; };
  await refresh();
  const held = await holdings(rpcUrl, w.address);
  // a token the desk traded that sits in the wallet without a book entry (state write lost after a buy): adopt it so it gets sold
  const known = new Map([...state.closed.slice(-30), ...state.positions].map((t) => [t.mint, t.symbol]));
  for (const mint of held.keys()) if (!L.pos[mint] && known.has(mint)) L.pos[mint] = { symbol: known.get(mint), ts: now, costUsd: 0, gotUsd: 0, half: false };

  // sells first: getting out matters more than getting in
  for (const mint of Object.keys(L.pos)) {
    const lp = L.pos[mint], paper = state.positions.find((p) => p.mint === mint);
    try {
      const bal = held.get(mint) || 0n;
      if (lp.pending) {
        if (bal > 0n) lp.pending = false; // the buy landed after we stopped waiting
        else if (now - lp.ts > 120_000) { delete L.pos[mint]; continue; } // blockhash expired: it can never land
        else continue;
      }
      const all = !want || !paper;
      const half = !all && paper.tp1Done && !lp.half;
      if (!all && !half) continue;
      if (bal > 0n) {
        const amount = all ? bal : (bal * BigInt(Math.round(cfg.exit.tp1SellFraction * 1000))) / 1000n;
        const bps = [300, 1000, 3000][Math.min(lp.tries || 0, 2)]; // a stuck exit widens slippage: out beats price
        lp.gotUsd += (await swap(w, rpcUrl, mint, SOL, amount, bps)) * L.solUsd;
        lp.tries = 0;
      }
      if (half) { lp.half = true; continue; }
      const pnl = lp.gotUsd - lp.costUsd;
      L.closed.push({ mint, symbol: lp.symbol, ts: lp.ts, exitTs: now, costUsd: +lp.costUsd.toFixed(2), gotUsd: +lp.gotUsd.toFixed(2), pnlUsd: +pnl.toFixed(2) });
      L.closed = L.closed.slice(-100);
      L.pnlUsd = +(L.pnlUsd + pnl).toFixed(2);
      delete L.pos[mint];
    } catch (e) { lp.tries = (lp.tries || 0) + 1; lp.err = e.message; }
  }

  // buys: only entries the paper desk made in the last 45 s. A late copy is a different, worse trade.
  if (want) for (const p of state.positions) {
    if (L.pos[p.mint] || now - p.entryTs > 45_000) continue;
    const exposure = Object.values(L.pos).reduce((a, x) => a + x.costUsd - x.gotUsd, 0);
    const usd = Math.min(L.capUsd, L.usd) * cfg.positionPct;
    const sol = usd / L.solUsd;
    if (usd < 1 || exposure + usd > L.capUsd || L.sol < sol + FEE_RESERVE_SOL) continue;
    const lp = (L.pos[p.mint] = { symbol: p.symbol, ts: now, costUsd: usd, gotUsd: 0, half: false, pending: true });
    try {
      lp.costUsd = -(await swap(w, rpcUrl, SOL, p.mint, Math.floor(sol * 1e9), 300)) * L.solUsd;
      lp.pending = false;
    } catch (e) { lp.err = e.message; } // stays pending: the next pass checks whether tokens arrived
    await refresh();
  }
  if (open.length) await refresh();
}

// Withdraw everything to one address (legacy System transfer, built by hand).
export async function transferAllTx(w, rpcUrl, to) {
  const dest = unb58(to);
  if (dest.length !== 32 || to === w.address) throw new Error('bad destination address');
  const lamports = (await lamportsOf(rpcUrl, w.address)) - 5000; // 5000 = fee for one signature
  if (lamports <= 0) throw new Error('wallet is empty');
  const { blockhash } = (await rpc(rpcUrl, 'getLatestBlockhash', [{ commitment: 'finalized' }])).value;
  const data = new Uint8Array(12);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 2, true); dv.setBigUint64(4, BigInt(lamports), true); // System instruction 2 = Transfer
  const msg = Uint8Array.from([1, 0, 1, 3, ...w.pub, ...dest, ...new Uint8Array(32), ...unb58(blockhash), 1, 2, 2, 0, 1, 12, ...data]);
  return { lamports, tx: Uint8Array.from([1, ...(await w.sign(msg)), ...msg]) };
}
export async function withdrawAll(secret, rpcUrl, to) {
  const { lamports, tx } = await transferAllTx(await signer(secret), rpcUrl, to);
  return { sig: await send(rpcUrl, tx), sol: lamports / 1e9 };
}
