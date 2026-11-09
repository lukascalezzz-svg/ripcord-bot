# Ripcord Desk

Trading desk for Solana meme coins. It trades on paper with live prices ($20 runs toward a $150 goal),
and can mirror those trades with real money from its own wallet once the paper record earns it.
Dashboard: https://ripcord-bot.vercel.app

## Six agents, no LLM in the hot path
Every agent is a plain function, so a decision takes milliseconds.

| Agent | Job |
|---|---|
| Scout | pulls tokens from DexScreener's paid lists and GeckoTerminal's organic trending (+ copied wallets) |
| Filter | liquidity, mcap, age, buyers vs sellers, momentum, volume |
| Analyst | RugCheck report: real holders (pools excluded), insiders, LP lock, dev history |
| Skeptic | veto on any red flag (mint/freeze authority, whale, insiders, thin LP, serial dev, top 10 can drain the pool) |
| Sniper | never buys on the first look: the token must pass every rule again 2 min later with the price held; then 30% of equity |
| Guard | stop -18%, sell 75% at +30% then trail 25%, moonshot +300%, dead coin, rug exits |

Paper costs are harsh on purpose: 1.25% per side, $0.05 network per side, plus price impact from pool depth.

## Tournament
No published source proves that any meme coin tactic makes money (the guides are written by people selling bots),
so the desk does not pick one on faith. `config.lab` holds challenger tactics; each overlays its entry/exit rules on
the house rules and trades its own $20 paper book on the same market with the same costs. Requests are shared, so
extra bots cost no extra API calls. The dashboard ranks them by profit since `live.gateFrom`.

| Bot | Hypothesis |
|---|---|
| Zamah (house) | buyer momentum, confirmed on a second look |
| Drugi talas | pumped earlier (h6 >= +50%), dumped over the last hour, buyers are coming back |
| Maturant | 3 to 30 min after leaving the pump.fun curve, buying has not stopped |
| Veteran | survived 6 h+, deep pool, calm climb; smaller wins, fewer rugs |

`config.live.follow = "<bot key>"` makes real money copy that bot; its own record then has to open the gate.
Tested and rejected (2026-11-09): pausing after a cold streak in the shadow book, and hour-of-day filters. Neither predicted the next outcome.

## Real money
- The bot owns a wallet created on the server (`rc_private.wallet_secret`, Phantom import format). The key never
  passes through a browser. The dashboard shows the address; fund it by sending SOL there.
- `bot/live.mjs` mirrors paper buys and sells through Jupiter. It runs only while `config.live.on` is true AND the
  gate is open: `gateTrades` closed paper trades since `gateFrom`, in profit, profit factor >= `gatePf`.
  If paper slides back into a loss the gate closes, the bot sells everything and stops.
- At most `capUsd` is ever in play; the rest of the wallet is not touched.
- Owner controls (switch, ripcord = sell all and stop, withdraw) sit in the dashboard behind the owner code.
  `node bot/admin-code.mjs` makes a new code in `.admin-code` (git-ignored) and prints the SQL that stores its hash.
- Not yet proven with real funds: a real swap landing on chain. Signing and transaction layout were checked against
  mainnet simulation, the rest against a fake chain in the tests. The first live trade is the real test.

## Where it runs
- `bot/run.mjs` holds the paper desk, `bot/live.mjs` the real-money mirror (both runtime-agnostic).
- Supabase project `trading-bot`: `pg_cron` calls the edge function `ripcord-tick` every 15 s with a private key;
  state lives in `rc_state` (public read-only), rules in `rc_state.config`. `ripcord-admin` takes owner commands
  and only edits config; the tick function is the single place that holds the wallet key.
- `dashboard/index.html` polls `rc_state` with the publishable key every 4 s.
- GitHub Actions only runs the tests.
- Deploys read from this repo at a pinned commit, so nothing is retyped: the deployed `ripcord-tick/index.ts` imports
  `run.mjs` and `live.mjs` from `raw.githubusercontent.com/<repo>/<commit>/bot/`, and the Vercel build downloads
  `dashboard/index.html` from the same commit. Push first, then deploy with the new commit hash.
- Deployed code must match the tested code: `node bot/sha.mjs` equals what `ripcord-tick?sha=1` answers.

## Daily routine
```
node bot/review.mjs      # what lost money, which rule blocked winners, gate progress
node bot/candles.mjs     # 1m candles around every decision (slow, free API)
node bot/backtest.mjs    # try entry/exit ideas on them; trust only what improves both halves
```
Rules live in the database, not in a deploy. Example:
```sql
update rc_state set config = jsonb_set(config, '{skeptic,maxTop10Pct}', '35') where id = 1;
```
`config.json` mirrors the defaults.

## Local
```
node --test bot/test.mjs
LOOP_SECONDS=60 node bot/local.mjs   # same desk, state in data/local-state.json
node bot/peek.mjs                     # read the live desk
```

v1 (GitHub cron, Nov 7) ended at $374: the cron fired every 3-7 h, so stops and rugs were never caught in time. History kept in `data/v1-state.json`.

Not financial advice. No rule set tested so far shows a proven edge; that is what the gate is for.
