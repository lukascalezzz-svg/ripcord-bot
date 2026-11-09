// Backtest entry and exit rules on 1m candles around every decision the desk made.
// First: node bot/candles.mjs. Then: node bot/backtest.mjs   (MODE=exits|ideas|filters, COST=0.05 round trip)
// Pessimistic on purpose: entry at the next minute's open, low checked before high, stops slip 4%.
// Only trust a change that improves BOTH halves of the sample.
import fs from 'node:fs';
const all = JSON.parse(fs.readFileSync(new URL('../data/candles.json', import.meta.url))).filter((x) => x.candles?.length > 20);
all.sort((a, b) => a.ts - b.ts);
// same token within 10 min = same decision
const items = [];
for (const x of all) if (!items.some((y) => y.mint === x.mint && Math.abs(y.ts - x.ts) < 10 * 60e3)) items.push(x);
const COST = Number(process.env.COST ?? 0.05); // round trip, share of position

// candle: [t, o, h, l, c, v]. Pessimistic inside a candle: the low is checked before the high.
function sim(x, P) {
  const c = x.candles;
  let i = c.findIndex((k) => k[0] * 1000 > x.ts);
  if (i < 0) return null;
  const ref = c[i][1];
  if (P.wait) { // confirmation: look again `wait` minutes later, enter only if price held
    const j = i + P.wait;
    if (!c[j]) return null;
    const g = c[j][1] / ref - 1;
    if (g < P.confMin || g > P.confMax) return null;
    i = j;
  }
  if (P.pre) { // context before entry
    const before = c.slice(Math.max(0, i - 15), i);
    if (before.length < 5) return null;
    const hi = Math.max(...before.map((k) => k[2]));
    const fromHi = c[i][1] / hi - 1;
    if (fromHi < P.pre[0] || fromHi > P.pre[1]) return null;
  }
  const e = c[i][1];
  let stop = e * (1 + P.stop), peak = e, qty = 1, got = 0, tp1 = false;
  const end = Math.min(c.length, i + (P.hold || 120));
  for (let k = i; k < end; k++) {
    const [t, , h, l, cl] = c[k];
    if (l <= stop) { got += qty * stop * (1 - (tp1 ? 0.03 : P.slip ?? 0.04)); qty = 0; break; }
    if (h > peak) peak = h;
    if (!tp1 && h >= e * (1 + P.tp1)) {
      got += qty * P.frac * e * (1 + P.tp1); qty *= 1 - P.frac; tp1 = true;
      stop = Math.max(P.be ? e * (1 + P.be) : stop, peak * (1 - P.trail));
    }
    if (tp1) stop = Math.max(stop, peak * (1 - P.trail));
    else if (P.lock && peak >= e * (1 + P.lock[0])) stop = Math.max(stop, e * (1 + P.lock[1])); // early profit lock before tp1
    if (!tp1 && P.tstop && k - i >= P.tstop[0] && cl < e * (1 + P.tstop[1])) { got += qty * cl; qty = 0; break; }
    if (h >= e * (1 + (P.hard ?? 3))) { got += qty * e * (1 + (P.hard ?? 3)); qty = 0; break; }
  }
  if (qty) got += qty * c[end - 1][4];
  return got / e - 1 - COST;
}
const ratio = (x) => x.f.buysM5 / Math.max(x.f.sellsM5, 1);
const CUR = (x) => ratio(x) >= 2.5 && ratio(x) <= 4.2 && x.f.score >= 6;
const stat = (set, P) => {
  const r = set.map((x) => sim(x, P)).filter((v) => v !== null);
  const half = Math.floor(r.length / 2);
  const m = (a) => (a.length ? (a.reduce((s, v) => s + v, 0) / a.length) * 100 : 0);
  return { n: r.length, mean: m(r), a: m(r.slice(0, half)), b: m(r.slice(half)), win: r.filter((v) => v > 0).length };
};
const show = (label, set, P) => { const s = stat(set, P); console.log(`${label.padEnd(46)} n ${String(s.n).padStart(3)}  mean ${s.mean.toFixed(1).padStart(6)}%  halves ${s.a.toFixed(1).padStart(6)} / ${s.b.toFixed(1).padStart(6)}  win ${s.win}`); return s; };

const X = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url))).exit;
const BASE = { stop: X.stopLossPct, tp1: X.tp1Pct, frac: X.tp1SellFraction, trail: X.trailPct, be: 0 };
const cur = items.filter(CUR);
console.log(`decisions ${items.length} (from ${all.length}), pass current filter ${cur.length}, cost ${COST}`);
console.log('\n== sanity: real trades vs sim');
for (const x of all.filter((x) => x.why === 'TRADE')) console.log(' ', x.sym.padEnd(11), 'real', String(x.pnlPct).padStart(6), 'sim', ((sim(x, BASE) ?? NaN) * 100).toFixed(1).padStart(6), x.reason);

console.log('\n== current exits, by entry set');
show('all decisions', items, BASE);
show('current filter', cur, BASE);

if (process.env.MODE === 'exits' || !process.env.MODE) {
  console.log('\n== exit grid (set: current filter | all)');
  const rows = [];
  for (const stop of [-0.12, -0.18, -0.25, -0.35]) for (const tp1 of [0.2, 0.3, 0.4, 0.6]) for (const trail of [0.15, 0.25, 0.35]) for (const frac of [0.5, 0.75]) {
    const P = { stop, tp1, frac, trail, be: 0 };
    rows.push({ P, c: stat(cur, P), a: stat(items, P) });
  }
  rows.sort((x, y) => y.a.mean - x.a.mean);
  for (const r of rows.slice(0, 8)) console.log(JSON.stringify(r.P), `cur ${r.c.mean.toFixed(1)}% (${r.c.a.toFixed(1)}/${r.c.b.toFixed(1)})  all ${r.a.mean.toFixed(1)}% (${r.a.a.toFixed(1)}/${r.a.b.toFixed(1)})`);
  console.log('worst:', JSON.stringify(rows.at(-1).P), rows.at(-1).a.mean.toFixed(1));
}
if (process.env.MODE === 'ideas' || !process.env.MODE) {
  console.log('\n== ideas on top of current exits (set: all | current filter)');
  const ideas = {
    'base': {},
    'tp1 +30%, sell 75%': { tp1: 0.3, frac: 0.75 },
    'tp1 +30%, sell 75% + confirm 2m': { tp1: 0.3, frac: 0.75, wait: 2, confMin: 0, confMax: 0.3 },
    'tp1 +30%, sell 50%': { tp1: 0.3 },
    'tp1 +40%, sell 75%': { frac: 0.75 },
    'time stop 5m <+0%': { tstop: [5, 0] },
    'time stop 10m <+5%': { tstop: [10, 0.05] },
    'time stop 20m <+5%': { tstop: [20, 0.05] },
    'lock: +15% peak -> stop at entry': { lock: [0.15, 0] },
    'lock: +20% peak -> stop +5%': { lock: [0.2, 0.05] },
    'confirm 1m, price held (>=0%)': { wait: 1, confMin: 0, confMax: 0.25 },
    'confirm 2m, price held (>=0%)': { wait: 2, confMin: 0, confMax: 0.3 },
    'confirm 2m, held >= -3%': { wait: 2, confMin: -0.03, confMax: 0.3 },
    'confirm 3m, up >= +3%': { wait: 3, confMin: 0.03, confMax: 0.4 },
    'pullback entry: 5-20% under 15m high': { pre: [-0.2, -0.05] },
    'breakout entry: within 5% of 15m high': { pre: [-0.05, 1] },
    'deep pullback: >20% under 15m high': { pre: [-1, -0.2] },
  };
  for (const [k, v] of Object.entries(ideas)) { show(`all | ${k}`, items, { ...BASE, ...v }); show(`cur | ${k}`, cur, { ...BASE, ...v }); }
}
if (process.env.MODE === 'filters' || !process.env.MODE) {
  console.log('\n== entry filters with current exits');
  const F = {
    'ratio 2-4.2': (x) => ratio(x) >= 2 && ratio(x) <= 4.2,
    'ratio 2.5-4.2 (no score)': (x) => ratio(x) >= 2.5 && ratio(x) <= 4.2,
    'ratio 3-4.2': (x) => ratio(x) >= 3 && ratio(x) <= 4.2,
    'ratio < 2': (x) => ratio(x) < 2,
    'ratio > 4.2': (x) => ratio(x) > 4.2,
    'liq 30-100k': (x) => x.f.liq >= 30e3 && x.f.liq < 100e3,
    'liq < 30k': (x) => x.f.liq < 30e3,
    'liq >= 100k': (x) => x.f.liq >= 100e3,
    'age < 30m': (x) => x.f.ageMin < 30,
    'age 30-180m': (x) => x.f.ageMin >= 30 && x.f.ageMin < 180,
    'age >= 180m': (x) => x.f.ageMin >= 180,
    'chM5 < 6': (x) => x.f.chM5 < 6,
    'chM5 >= 10': (x) => x.f.chM5 >= 10,
    'chH1 < 50': (x) => x.f.chH1 < 50,
    'chH1 >= 100': (x) => x.f.chH1 >= 100,
    'vol/liq >= 4': (x) => x.f.volH1 / x.f.liq >= 4,
    'vol/liq < 2': (x) => x.f.volH1 / x.f.liq < 2,
    'buysM5 >= 300': (x) => x.f.buysM5 >= 300,
    'buysM5 < 150': (x) => x.f.buysM5 < 150,
  };
  for (const [k, f] of Object.entries(F)) show(k, items.filter(f), BASE);
}
