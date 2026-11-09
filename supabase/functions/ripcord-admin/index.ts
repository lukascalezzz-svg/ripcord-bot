// Owner controls for the live wallet. The dashboard is public, so every call must carry the owner code;
// only its sha256 is stored. This function never sees the wallet key: it only edits config, and the
// tick function (the single place that holds the key) acts on it within 15 s.
const URL_ = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization, apikey', 'content-type': 'application/json' };

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${path}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: CORS });
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  try {
    const { code, action, on, to } = await req.json();
    const [priv] = await rest('rc_private?select=admin_hash');
    if (!priv.admin_hash || typeof code !== 'string' || (await sha256(code)) !== priv.admin_hash) {
      await new Promise((r) => setTimeout(r, 1500)); // slow down guessing
      return reply({ error: 'Pogrešna šifra.' }, 403);
    }
    const [row] = await rest('rc_state?select=config,live:state->live&id=eq.1');
    const live = { ...row.config.live };
    if (action === 'live') live.on = !!on;
    else if (action === 'withdraw') {
      if (live.on || Object.keys(row.live?.pos || {}).length) return reply({ error: 'Prvo povuci ripcord i sačekaj da bot proda sve pozicije.' }, 409);
      if (typeof to !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to) || to === row.live?.address) return reply({ error: 'To nije ispravna Solana adresa za isplatu.' }, 400);
      live.withdrawTo = to;
    } else return reply({ error: 'Nepoznata radnja.' }, 400);
    // touches only the config column, so it never collides with the tick writing state
    await rest('rc_state?id=eq.1', { method: 'PATCH', body: JSON.stringify({ config: { ...row.config, live } }) });
    return reply({ ok: true, on: live.on });
  } catch (e) {
    return reply({ error: (e as Error).message }, 500);
  }
});
