// Local runner: same desk as Supabase, state in data/state.json. LOOP_SECONDS=60 node bot/local.mjs
import fs from 'node:fs';
import { tick, freshState, finish, equity } from './run.mjs';

const ROOT = new URL('..', import.meta.url);
const FILE = new URL(process.env.STATE_FILE || 'data/local-state.json', ROOT);
const cfg = JSON.parse(fs.readFileSync(new URL('config.json', ROOT)));
const state = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE)) : freshState(cfg);
const until = Date.now() + (Number(process.env.LOOP_SECONDS) || 0) * 1000;
const every = (Number(process.env.TICK_SECONDS) || 15) * 1000;

do {
  const t0 = Date.now();
  try { await tick(state, cfg, t0, { rpcUrl: process.env.RPC_URL }); } catch (err) { console.error('tick failed', err.message); }
  fs.writeFileSync(FILE, JSON.stringify(finish(state)));
  for (const f of state.feed.filter((f) => f.ts >= t0)) console.log(`[${f.agent}] ${f.text}`);
  const wait = every - (Date.now() - t0);
  if (Date.now() + wait >= until) break;
  await new Promise((r) => setTimeout(r, Math.max(wait, 0)));
} while (true);
console.log(`equity $${equity(state).toFixed(2)} | open ${state.positions.length} | closed ${state.closed.length}`);
