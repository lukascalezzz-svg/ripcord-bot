// Read the live desk exactly like the dashboard does (public key, read-only). node bot/peek.mjs
const U = 'https://xgwazrawzivaqoiwwysl.supabase.co/rest/v1';
const H = { apikey: 'sb_publishable_rJinet3DRSjTdXP2vb9HEA_j6mqlvIx' };

const [row] = await (await fetch(`${U}/rc_state?select=updated_at,state`, { headers: H })).json();
const s = row.state;
const eq = s.cashUsd + s.positions.reduce((a, p) => a + p.qty * (p.lastPrice || p.entryPrice), 0);
const d = Object.entries(s.days).at(-1);
console.log(`updated ${row.updated_at} | lastRun ${new Date(s.lastRun).toISOString()} | equity $${eq.toFixed(2)} | open ${s.positions.length} | closed ${s.closed.length}`);
if (d) console.log('agents', JSON.stringify(d[1].agents), '| top rejects', JSON.stringify(Object.entries(d[1].rejects).sort((a, b) => b[1] - a[1]).slice(0, 5)));
if (s.lastError) console.log('lastError', s.lastError);
for (const f of s.feed.slice(-8)) console.log(`  [${f.agent}] ${f.text}`);
const priv = await fetch(`${U}/rc_private?select=*`, { headers: H });
console.log('private table via public key:', priv.status, (await priv.text()).slice(0, 60));
