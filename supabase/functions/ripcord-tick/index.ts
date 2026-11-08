// One desk tick per call. pg_cron calls this every 15 s with the private cron key.
import { tick, freshState, finish } from './run.mjs';

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
  const [{ cron_key }] = await rest('rc_private?select=cron_key');
  if (req.headers.get('x-cron-key') !== cron_key) return new Response('forbidden', { status: 403 });
  if (!(await rest('rpc/rc_try_lock', { method: 'POST', body: JSON.stringify({ secs: 60 }) }))) return new Response('busy');
  try {
    const [row] = await rest('rc_state?select=state,config&id=eq.1');
    const cfg = row.config;
    const state = row.state?.version === 2 ? row.state : freshState(cfg);
    const t0 = Date.now();
    try { await tick(state, cfg, t0, { rpcUrl: Deno.env.get('RPC_URL') }); } catch (e) { console.error('tick', (e as Error).message); state.lastError = { ts: t0, msg: (e as Error).message }; }
    finish(state);
    await rest('rc_state?id=eq.1', { method: 'PATCH', body: JSON.stringify({ state, updated_at: new Date().toISOString() }) });
    return new Response(`ok ${Date.now() - t0}ms`);
  } finally {
    await rest('rpc/rc_unlock', { method: 'POST', body: '{}' });
  }
});
