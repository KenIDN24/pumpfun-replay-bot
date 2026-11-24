# pumpfun-replay-bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/KenIDN24/pumpfun-replay-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/KenIDN24/pumpfun-replay-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A deterministic paper-trading bot for pump.fun replay data — it buys the dip after a proven 2x pump. Built by an AI agent for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty, $2 in USDC.

## Strategy

Most pump.fun coins cliff-dump ~80% in a single trade, so chasing momentum
buys the top and a stop-loss can only fire after the cliff. This bot instead
buys the dip: only coins that already peaked at >= 2x their first-trade
price and retraced to <= 70% of that peak (and <= 1.4x the first price),
with fresh buy flow returning (>= 60% buys over the last 10 trades) and
>= 2 SOL of real reserves. Size 0.02 SOL per entry, one entry per mint ever,
max 5 open positions. Exits: stop-loss -12%, trailing stop armed at +50%
(sells 30% below the peak), time stop after ~12 minutes.

Local dev-window grade (house replay, 10 SOL paper): **PnL -0.027 SOL**
(essentially breakeven), **92 round trips** on 92 distinct mints, **max
drawdown 2.3%**, 5 wins averaging +0.049 SOL (best +0.223 SOL) vs 90
losses averaging -0.003 SOL. The payoff is deliberately asymmetric: the
rare second leg pays ~17x the average loss.

## Run it

The bot speaks `agent-fun/replay/v2` (NDJSON over stdin/stdout) and runs
under Node 22:

```sh
node main.ts
```

Grade it locally with the contest kit:

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=c8w480ny&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
