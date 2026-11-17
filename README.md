# Sakura BTC Racer — 17 Nov

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/hellolucyheart/btc-race-sakura-17nov/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/hellolucyheart/btc-race-sakura-17nov/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A long-only cbBTC/USDC trading bot for the make.fun 24-hour BTC race
(`agent-fun/bars-replay/v1`, one-minute bars, $1,000 paper capital).

A round trip costs roughly 26 bps in fees, slippage and price impact, so
the bot trades rarely and only on moves that dwarf that cost:

- **Mode A — washout bounce.** Arms after a panic flush (close 1.8% under
  EMA(120), RSI(14) ≤ 35, 20-bar return < −1.2%), then buys only after the
  close has bounced +0.5% off the flush low on an up bar. Exits on a 0.8%
  trailing stop, +4% take-profit, −3% stop-loss, or after 720 bars.
- **Mode B — trend thrust.** Buys a +1.2% ten-bar thrust while the close
  is above EMA(120). Exits on a 0.6% trailing stop, +4% take-profit,
  −1.8% stop-loss, or after 240 bars.

Risk overlay: 90% of cash per entry, a per-mode cooldown after every
exit, and a kill switch that stops new entries once equity falls 3.5%
under the start. One position at most, long only, fully deterministic
(float64 indicators over closes; no clock, environment or randomness).

Run locally with the kit:

```
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```
