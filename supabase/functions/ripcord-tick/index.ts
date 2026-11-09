// One desk tick per call. pg_cron calls this every 15 s with the private cron key.
import * as R from './run.mjs';
import * as L from './live.mjs';
const { runAll, freshState, finish } = R;
const { mirror, newWallet, PUBLIC_RPC } = L;
// fingerprint of the deployed logic, to prove it is the same code the tests ran (node bot/sha.mjs prints the local one)
const sha = async () => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode([R, L].map((m) => Object.keys(m).sort().map((k) => String((m as Record<string, unknown>)[k])).join('')).join(''))))].map((b) => b.toString(16).padStart(2, '0')).join('');

const URL_ = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${path}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

Deno.serve(async (req) => {
  const [priv] = await rest('rc_private?select=cron_key,wallet_secret');
  if (req.headers.get('x-cron-key') !== priv.cron_key) return new Response('forbidden', { status: 403 });
  if (new URL(req.url).searchParams.has('sha')) return new Response(await sha());
  // lock outlives the slowest tick (edge wall clock is 150 s)
  if (!(await rest('rpc/rc_try_lock', { method: 'POST', body: JSON.stringify({ secs: 160 }) }))) return new Response('busy');
  try {
    const [row] = await rest('rc_state?select=state,config,updated_at&id=eq.1');
    const cfg = row.config;
    const state = row.state?.version === 3 ? row.state : freshState(cfg);
    const t0 = Date.now();
    const rpcUrl = Deno.env.get('RPC_URL') || PUBLIC_RPC;
    try { await runAll(state, cfg, t0, { rpcUrl }); } catch (e) { console.error('tick', (e as Error).message); state.lastError = { ts: t0, msg: (e as Error).message }; }
    // the bot's own wallet is born here, on the server: its key never passes through a browser or a chat
    let secret = priv.wallet_secret;
    if (!secret) {
      secret = (await newWallet()).secret;
      await rest('rc_private?id=eq.1&wallet_secret=is.null', { method: 'PATCH', body: JSON.stringify({ wallet_secret: secret }) });
    }
    try { const f = L.followed(state, cfg); await mirror(f.view, f.vcfg, secret, rpcUrl, t0); if (state.live) delete state.live.err; } catch (e) { console.error('live', (e as Error).message); (state.live ||= {}).err = { ts: t0, msg: (e as Error).message }; }
    // owner asked (ripcord-admin, with the owner code) to send the wallet's SOL to their address
    const to = cfg.live?.withdrawTo;
    if (to && state.live && !Object.keys(state.live.pos || {}).length) {
      try { state.live.out = { ts: t0, to, ...(await L.withdrawAll(secret, rpcUrl, to)) }; state.live.balTs = 0; } catch (e) { state.live.out = { ts: t0, to, err: (e as Error).message }; }
      // re-read config so a switch flipped during this tick is not undone; one attempt per request, never a retry loop with money
      const [fresh] = await rest('rc_state?select=config&id=eq.1');
      delete fresh.config.live.withdrawTo;
      await rest('rc_state?id=eq.1', { method: 'PATCH', body: JSON.stringify({ config: fresh.config }) });
    }
    finish(state);
    // only write over the row we read: if anything else wrote meanwhile, drop this tick instead of erasing trades
    await rest(`rc_state?id=eq.1&updated_at=eq.${encodeURIComponent(row.updated_at)}`, {
      method: 'PATCH', body: JSON.stringify({ state, updated_at: new Date().toISOString() }),
    });
    return new Response(`ok ${Date.now() - t0}ms`);
  } finally {
    await rest('rpc/rc_unlock', { method: 'POST', body: '{}' });
  }
});
