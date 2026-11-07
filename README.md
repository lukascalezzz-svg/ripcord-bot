# Ripcord

Paper-trading bot for Solana meme coins. Live prices, virtual money ($1,000 start).

- `bot/run.mjs`: scans DexScreener every 20 s, filters by momentum and safety (RugCheck), copies tracked wallets, manages exits.
- `config.json`: every rule the bot uses. Tune here.
- `data/state.json`: written by the bot (positions, closed trades, equity, reject stats).
- `dashboard/`: static page (Vercel) that reads `data/state.json` straight from this repo.
- `.github/workflows/bot.yml`: runs every 5 min, each run ticks for ~4.5 min, then commits state.

Costs are simulated on purpose: 1% per side plus price impact from pool depth. A paper result that ignores slippage lies.

## Copy trading
Add wallet addresses to `config.json` → `copy.wallets`. For reliable RPC, add a free Helius RPC URL as the repo secret `RPC_URL` (Settings → Secrets and variables → Actions).

## Run locally
```
node --test bot/test.mjs
LOOP_SECONDS=60 node bot/run.mjs
```

Not financial advice. Paper only until the numbers prove otherwise.
