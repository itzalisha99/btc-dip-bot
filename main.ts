// btc-dip-bot: a dip-buy mean-reversion bot for CBBTC/USDC, 1-minute bars.
//
// Idea, in plain words: Bitcoin usually snaps back a little after a sharp
// short fall. This bot waits in cash, buys only after a clear dip, and sells
// as soon as it has banked a modest rebound, or cuts the loss if the dip
// keeps falling. It trades rarely on purpose: every round trip costs about
// 26 bps in fees, slippage and pool impact, so a trade must catch a move
// much bigger than that. Few trades, small drawdowns, no chasing.
//
// Rules (all decided on a bar's close, filled at the next bar's open):
//   Entry: the close is at least 1.5% below the close 120 minutes ago.
//     That is the dip. The bot buys with all of its cash (one position max).
//   Exit, whichever comes first:
//     - take profit: close 2.0% above the buy fill price
//     - stop loss: close 1.2% below the buy fill price
//     - trailing stop: once the price has run 1.0% above entry, sell if it
//       falls 1.2% from the highest close since entry
//     - stale trade: after 480 minutes held, sell whatever the price is
//   Cooldown: after any sell, wait 60 minutes before the next buy, so one
//     falling market cannot trigger buy after buy.
//   Fallback (so the bot still trades in a quiet race window): if it has
//     made no buy yet and 1000 bars have passed, the dip threshold drops to
//     0.8% over 120 minutes; after 1300 bars it drops to 0.5% over 60
//     minutes. A quiet window still gets at least one disciplined trade,
//     and the same take-profit / stop-loss rules still apply to it.
//
// Determinism: no clock, no environment, no Math.random. Every decision is
// a pure function of the closes seen so far and the fills reported by the
// harness, so two runs on the same bars give the same orders byte for byte.
// Prices are read as integers from the bars; ratios use float64 arithmetic
// on those integers, which is deterministic under IEEE 754.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Dip window: compare the close with the close this many bars ago.
const DIP_WINDOW = 120;
// Main dip: close at least this far below the close DIP_WINDOW bars ago.
const DIP_PCT = 0.015;
// Fallback dips, used late in the window when no buy has happened yet.
const FALLBACK_BAR = 1000;
const FALLBACK_DIP_PCT = 0.008;
const LATE_BAR = 1300;
const LATE_WINDOW = 60;
const LATE_DIP_PCT = 0.005;
// Exits, measured from the buy fill price.
const TAKE_PROFIT_PCT = 0.02;
const STOP_LOSS_PCT = 0.012;
// Trailing stop: arm once the price is this far above entry, then sell if
// it falls this far from the highest close since entry.
const TRAIL_ARM_PCT = 0.01;
const TRAIL_DROP_PCT = 0.012;
// Stale-trade exit, in bars held.
const MAX_HOLD_BARS = 480;
// Cooldown after a sell, in bars.
const COOLDOWN_BARS = 60;
// Slippage caps: a buy refused if the next open is more than this above
// the close it was decided on; a sell refused if it is more than this below.
const BUY_SLIPPAGE_BPS = 150;
const SELL_SLIPPAGE_BPS = 200;

// Closes seen so far, in bar order, as plain numbers (price-scale units).
const closes: number[] = [];
// Bars since the window started (seq counts warm-up bars too, of which
// there are none in this competition, so seq is the bar index).
let entryPrice = 0;
let peakPrice = 0;
let entryBar = -1;
let lastSellBar = -1000000;
let buysMade = 0;

function dipThreshold(seq: number): { window: number; pct: number } | null {
  if (buysMade === 0 && seq >= LATE_BAR) return { window: LATE_WINDOW, pct: LATE_DIP_PCT };
  if (buysMade === 0 && seq >= FALLBACK_BAR) return { window: DIP_WINDOW, pct: FALLBACK_DIP_PCT };
  return { window: DIP_WINDOW, pct: DIP_PCT };
}

await runBars({
  onBatch(state: BarsState, batch) {
    // Learn the fill price of any buy that just landed, so exits are
    // measured from what we actually paid, not from a guessed price.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL) continue;
      if (fill.status === 'filled' && fill.side === 'buy') {
        entryPrice = Number(fill.price);
        peakPrice = entryPrice;
        entryBar = state.seq;
        buysMade += 1;
      }
      if (fill.status === 'filled' && fill.side === 'sell') {
        lastSellBar = state.seq;
        entryPrice = 0;
        peakPrice = 0;
        entryBar = -1;
      }
    }

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    closes.push(close);
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const orders: (BuyInput | SellInput)[] = [];

    if (held !== undefined && held.qty > 0n) {
      if (entryPrice > 0) {
        if (close > peakPrice) peakPrice = close;
        const gain = close / entryPrice - 1;
        const fromPeak = close / peakPrice - 1;
        const heldBars = state.seq - entryBar;
        const takeProfit = gain >= TAKE_PROFIT_PCT;
        const stopLoss = gain <= -STOP_LOSS_PCT;
        const trailing =
          peakPrice >= entryPrice * (1 + TRAIL_ARM_PCT) && fromPeak <= -TRAIL_DROP_PCT;
        const stale = heldBars >= MAX_HOLD_BARS;
        if (takeProfit || stopLoss || trailing || stale) {
          orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: SELL_SLIPPAGE_BPS });
          return orders;
        }
      }
      return [];
    }

    // Flat: only buy after a dip, and never inside the cooldown.
    if (state.seq - lastSellBar < COOLDOWN_BARS) return [];
    const rule = dipThreshold(state.seq);
    if (rule === null) return [];
    if (closes.length <= rule.window) return [];
    const reference = closes[closes.length - 1 - rule.window];
    if (reference <= 0) return [];
    const drop = close / reference - 1;
    if (drop > -rule.pct) return [];

    const cash = state.cash;
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    if (cash < minNotional) return [];
    // Spend all cash: one position, full size, so a winning rebound pays.
    orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: BUY_SLIPPAGE_BPS });
    return orders;
  },
});
