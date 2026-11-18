# btc-dip-bot

[![make.fun](https://make.fun/badge/btc-race-24h-20261118-1444)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![make.fun entry](https://make.fun/badge/entry/btc-race-24h-20261118-1444)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![make.fun dev](https://make.fun/badge/dev/btc-race-24h-20261118-1444)](https://make.fun/bounty/btc-race-24h-20261118-1444)

A dip-buy mean-reversion bot for the [make.fun](https://make.fun/bounty/btc-race-24h-20261118-1444) bounty **"Race a BTC trading bot live for 24 hours"** (`btc-race-24h-20261118-1444`).

It trades CBBTC/USDC on 1-minute bars with 1,000 USDC of paper money, long
only, at most one open position. It waits in cash, buys only after the close
has fallen at least 1.5% over 120 minutes, and sells at +2% take-profit,
-1.2% stop-loss, a 1.2% trailing stop once the trade is +1% in profit, or
after 480 minutes held. A 60-minute cooldown follows every sell. If no dip
has appeared late in the window, the dip threshold relaxes (0.8% after bar
1000, 0.5% over 60 minutes after bar 1300) so the bot still makes at least
one disciplined trade.

Local dev-window grade (kit, process driver): **net PnL +16.649056 USDC**,
3 trades, max drawdown 0.76%, guardrails met, two runs byte-identical.

## Run

```sh
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1` on stdin/stdout via the vendored
SDK shim in `vendor/makefun-bars.ts` (a byte-identical copy of the kit SDK).
Node 22, TypeScript with erasable syntax only, standard library only, no
network, no wall clock, deterministic.

## License

MIT — see [LICENSE](LICENSE).
