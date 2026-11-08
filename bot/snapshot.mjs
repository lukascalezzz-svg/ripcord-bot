// Save the live desk state to a file before a reset. node bot/snapshot.mjs data/v2-state.json
import fs from 'node:fs';
const U = 'https://xgwazrawzivaqoiwwysl.supabase.co/rest/v1';
const H = { apikey: 'sb_publishable_rJinet3DRSjTdXP2vb9HEA_j6mqlvIx' };
const [row] = await (await fetch(`${U}/rc_state?select=state`, { headers: H })).json();
fs.writeFileSync(process.argv[2], JSON.stringify(row.state));
console.log('saved', process.argv[2], row.state.closed.length, 'closed', row.state.positions.length, 'open');
