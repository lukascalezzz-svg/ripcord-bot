# Ripcord Desk

Paper-trading desk for Solana meme coins. Live prices, virtual money ($1,000 start).
Dashboard: https://ripcord-bot.vercel.app

## Six agents, no LLM in the hot path
Every agent is a plain function, so a decision takes milliseconds.

| Agent | Job |
|---|---|
| Scout | pulls fresh tokens from DexScreener (+ copied wallets) |
| Filter | liquidity, mcap, age, buyers vs sellers, momentum, volume |
| Analyst | RugCheck report: real holders (pools excluded), insiders, LP lock, dev history |
| Skeptic | veto on any red flag (mint/freeze authority, whale, insiders, thin LP, serial dev) |
| Sniper | sizes the entry (10% of equity, 15% for copied wallets) |
| Guard | stop -18%, sell half at +40% then trail 25%, moonshot +300%, dead coin, rug exits |

Costs are simulated on purpose: 1% per side plus price impact from pool depth.

## Where it runs
- `bot/run.mjs` holds all agent logic (runtime-agnostic).
- Supabase project `trading-bot`: `pg_cron` calls the edge function `ripcord-tick` every 15 s with a private key; state lives in `rc_state` (public read-only), rules in `rc_state.config`.
- `dashboard/index.html` polls `rc_state` with the publishable key every 4 s.
- GitHub Actions only runs the tests.

## Tune the rules
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

Not financial advice. Paper only until the numbers prove otherwise.
