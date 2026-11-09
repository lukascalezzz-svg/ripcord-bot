// Daily review: what lost money, and were the rules right? node bot/review.mjs [state.json]
// Reads the live desk with the public key (or a saved state file).
import fs from 'node:fs';

const U = 'https://xgwazrawzivaqoiwwysl.supabase.co/rest/v1';
const H = { apikey: 'sb_publishable_rJinet3DRSjTdXP2vb9HEA_j6mqlvIx' };
const s = process.argv[2]
  ? JSON.parse(fs.readFileSync(process.argv[2]))
  : (await (await fetch(`${U}/rc_state?select=state`, { headers: H })).json())[0].state;

const $ = (v) => (v >= 0 ? '+' : '−') + '$' + Math.abs(v).toFixed(2);
const pct = (a, b) => ((a / b - 1) * 100).toFixed(0) + '%';
const eq = s.cashUsd + s.positions.reduce((a, p) => a + p.qty * (p.lastPrice || p.entryPrice), 0);

console.log(`\nRUN #${s.run?.n ?? '-'}: $${eq.toFixed(2)} / cilj $${s.run?.goalUsd ?? '-'} (vrh $${s.run?.peakUsd ?? '-'}) · otvoreno ${s.positions.length}`);
for (const r of s.runs || []) console.log(`  #${r.n} ${r.result === 'cilj' ? 'CILJ ' : 'BUST '} $${r.startUsd} → $${r.endUsd} (vrh $${r.peakUsd}), ${r.wins}/${r.trades} dobitnih`);

const group = (rows, key) => {
  const g = {};
  for (const t of rows) { const k = key(t); (g[k] ||= { n: 0, usd: 0, w: 0 }); g[k].n++; g[k].usd += t.pnlUsd; if (t.pnlUsd > 0) g[k].w++; }
  return Object.entries(g).sort((a, b) => a[1].usd - b[1].usd);
};
console.log('\nIZLAZI (najgori prvi)');
for (const [k, v] of group(s.closed, (t) => t.reason)) console.log(`  ${k.padEnd(22)} ${String(v.n).padStart(3)}x  ${$(v.usd).padStart(9)}  ${v.w}/${v.n} dobitnih`);
const slip = s.closed.filter((t) => t.reason === 'stop loss' && t.pnlPct < -25);
if (slip.length) console.log(`  ! stop proklizao (gore od −25%): ${slip.map((t) => `${t.symbol} ${t.pnlPct}%`).join(', ')}`);

// shadow: first touch of +tp1 vs stop within the window, per decision
const done = (s.shadow || []).filter((x) => x.done || x.first);
console.log(`\nSENKA: ${done.length} odluka ocenjeno (prvi dodir +TP pre stopa u 60 min)`);
const g = {};
for (const x of done) { const k = x.why; (g[k] ||= { n: 0, win: 0, loss: 0, hi: 0 }); g[k].n++; if (x.first === 'win') g[k].win++; if (x.first === 'loss') g[k].loss++; g[k].hi += x.hi / x.p0 - 1; }
for (const [k, v] of Object.entries(g).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${k.slice(0, 40).padEnd(40)} ${String(v.n).padStart(3)}x  win ${v.win}  loss ${v.loss}  prosečan vrh +${((v.hi / v.n) * 100).toFixed(0)}%`);
}
// which source finds better tokens: paid DexScreener lists ("boost") or organic GeckoTerminal trending ("trend")
const src = {};
for (const x of done) { const k = x.f?.src || 'boost'; (src[k] ||= { n: 0, win: 0, loss: 0 }); src[k].n++; if (x.first === 'win') src[k].win++; if (x.first === 'loss') src[k].loss++; }
console.log('  po izvoru: ' + Object.entries(src).map(([k, v]) => `${k} ${v.n}x win ${v.win} loss ${v.loss}`).join(' · '));
const lg = s.live?.gate;
if (lg) console.log(`\nKAPIJA ZA PRAVI NOVAC: ${lg.trades}/${lg.need} trejdova, ${$(lg.pnlUsd)}, profit faktor ${lg.pf} (treba ${lg.minPf}) → ${lg.ok ? 'OTVORENA' : 'zaključana'}`);
const missed = done.filter((x) => x.why !== 'kupljeno' && x.first === 'win');
if (missed.length) console.log(`  propušteni pobednici: ${missed.slice(-8).map((x) => `${x.s} (${x.why}, vrh ${pct(x.hi, x.p0)})`).join(', ')}`);
console.log('\nPravilo: pravilo koje blokira više pobednika nego gubitnika se labavi; filter "kupljeno" sa više loss nego win se steže.\n');
