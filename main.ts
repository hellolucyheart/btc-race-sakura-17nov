// Sakura BTC Racer — 17 Nov edition — a long-only cbBTC bot for agent-fun/bars-replay/v1.
//
// Design (built for a 6+ bps fee + slippage + impact round trip, so it trades
// rarely and only on moves that dwarf the cost of trading):
//
//   Mode A — washout bounce (mean reversion after a panic flush):
//     Arm when the close sits at least DEV (1.8%) below its EMA(120), RSI(14)
//     is under 35 and the trailing 20-bar return is below -1.2%. While armed
//     (90 bars) track the flush low; buy only once the close has bounced
//     CONFIRM (0.5%) off that low on an up bar — never catch the falling
//     knife itself. Exit on a 0.8% trailing stop from the peak close, a
//     +4% take-profit, a -3% stop-loss, or after 720 bars.
//
//   Mode B — trend thrust (momentum ignition inside an uptrend):
//     When the close is above EMA(120) and the trailing 10-bar return
//     exceeds +1.2%, ride the thrust. Exit on a 0.6% trailing stop, a +4%
//     take-profit, a -1.8% stop-loss, or after 240 bars.
//
//   Risk overlay: 90% of cash per entry (impact-aware: a full-size round
//   trip costs ~26 bps, and 90% keeps the impact leg near 13 bps a side),
//   a per-mode cooldown after every exit, and a kill switch that stops new
//   entries once equity falls 3.5% under the 1,000 USDC start — the dev
//   gate only needs a profit, and the race ranks by net PnL, so capital
//   preservation outranks activity. At most one position, long only.
//
// All indicators run in float64 on + - * / alone over the closes seen so
// far, so two runs over the same bars send byte-identical orders. No
// clock, no environment, no randomness is ever read. Race edition of
// 17 November 2026, adapted from the 15 Nov Sakura BTC Racer.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- shared parameters -------------------------------------------------
const STAKE_FRACTION = 0.9; // share of cash spent on an entry
const KILL_DRAWDOWN = 0.035; // stop opening positions below start * (1 - this)
const BUY_SLIPPAGE_BPS = 200; // entries may chase a gap up to 2% past the close
const SELL_SLIPPAGE_BPS = 300; // exits insist: up to 3% past the close

// --- Mode A: washout bounce --------------------------------------------
const A_DEV = 0.018; // close must be this far under EMA(120) to arm
const A_RSI_MAX = 35; // ... with RSI(14) at or under this
const A_DROP_BARS = 20; // trailing return window of the flush
const A_DROP = -0.012; // ... which must be under -1.2%
const A_ARM_BARS = 90; // an arming stays live this many bars
const A_CONFIRM = 0.005; // buy once the close is +0.5% off the flush low
const A_TAKE_PROFIT = 0.04;
const A_STOP_LOSS = 0.03;
const A_TRAIL = 0.008; // trailing stop under the peak close
const A_MAX_HOLD = 720;
const A_COOLDOWN = 30;

// --- Mode B: trend thrust ----------------------------------------------
const B_THRUST_BARS = 10; // trailing return window of the thrust
const B_THRUST = 0.012; // ... which must exceed +1.2% above EMA(120)
const B_TAKE_PROFIT = 0.04;
const B_STOP_LOSS = 0.018;
const B_TRAIL = 0.006;
const B_MAX_HOLD = 240;
const B_COOLDOWN = 60;

const EMA_SPAN = 120;
const RSI_SPAN = 14;
const WARMUP_BARS = 130; // indicators are trusted from this bar on (EMA/RSI settled)

// --- indicator state -----------------------------------------------------
const closes: number[] = [];
let ema120: number | null = null;
let rsiAvgGain = 0;
let rsiAvgLoss = 0;
let rsi: number | null = null;

function pushClose(close: number): void {
  const prev = closes.length > 0 ? closes[closes.length - 1] : null;
  closes.push(close);
  if (ema120 === null) ema120 = close;
  else ema120 += (2 / (EMA_SPAN + 1)) * (close - ema120);
  if (prev === null) return;
  const delta = close - prev;
  const gain = delta > 0 ? delta : 0;
  const loss = delta < 0 ? -delta : 0;
  const seen = closes.length - 1; // number of deltas so far
  if (seen <= RSI_SPAN) {
    rsiAvgGain += gain / RSI_SPAN;
    rsiAvgLoss += loss / RSI_SPAN;
    if (seen === RSI_SPAN) rsi = rsiAvgLoss === 0 ? 100 : 100 - 100 / (1 + rsiAvgGain / rsiAvgLoss);
  } else if (rsi !== null) {
    rsiAvgGain = (rsiAvgGain * (RSI_SPAN - 1) + gain) / RSI_SPAN;
    rsiAvgLoss = (rsiAvgLoss * (RSI_SPAN - 1) + loss) / RSI_SPAN;
    rsi = rsiAvgLoss === 0 ? 100 : 100 - 100 / (1 + rsiAvgGain / rsiAvgLoss);
  }
}

function trailingReturn(bars: number): number | null {
  if (closes.length <= bars) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - bars];
  return now / then - 1;
}

// --- position state ------------------------------------------------------
type Mode = 'A' | 'B';
let mode: Mode | null = null;
let entryPrice = 0; // the fill price of the open position (raw price units)
let entrySeq = -1;
let peakClose = 0;
let armedUntil = -1;
let flushLow = 0;
let entrySentSeq = -1; // seq the in-flight entry order was decided on
let cooldownAUntil = -1;
let cooldownBUntil = -1;
let startEquity: bigint | null = null;

function noteFills(state: BarsState, batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
    if (fill.side === 'buy' && mode !== null && entrySeq === -1) {
      entryPrice = Number(fill.price);
      entrySeq = batch.seq;
      peakClose = closes.length > 0 ? closes[closes.length - 1] : entryPrice;
    }
  }
  // A position that vanished (exit filled, or the end flatten) resets the
  // trade state; the cooldown was already set when the exit was sent.
  if (!state.positions.has(SYMBOL) && mode !== null && entrySeq !== -1) {
    mode = null;
    entrySeq = -1;
    entryPrice = 0;
    peakClose = 0;
  }
}

function entryOrders(state: BarsState): (BuyInput | SellInput)[] {
  if (startEquity === null) startEquity = state.equity;
  // Kill switch: no new risk once equity is 3.5% under the start.
  if (state.equity * 1000n < startEquity * 965n) return [];
  const close = closes[closes.length - 1];
  const seq = state.seq;

  // Mode A arming: a panic flush far under the trend average.
  if (seq >= cooldownAUntil && ema120 !== null && rsi !== null) {
    const drop = trailingReturn(A_DROP_BARS);
    if (drop !== null && close < ema120 * (1 - A_DEV) && rsi <= A_RSI_MAX && drop < A_DROP) {
      if (armedUntil < seq) flushLow = close;
      else if (close < flushLow) flushLow = close;
      armedUntil = seq + A_ARM_BARS;
    }
    if (armedUntil >= seq && flushLow > 0 && close >= flushLow * (1 + A_CONFIRM) && closes.length >= 2 && close > closes[closes.length - 2]) {
      armedUntil = -1;
      flushLow = 0;
      mode = 'A';
      entrySeq = -1;
      entrySentSeq = seq;
      const notional = (state.cash * BigInt(Math.round(STAKE_FRACTION * 1000))) / 1000n;
      if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: BUY_SLIPPAGE_BPS }];
      }
      mode = null;
      return [];
    }
  }

  // Mode B: a thrust inside an uptrend.
  if (seq >= cooldownBUntil && ema120 !== null && close > ema120) {
    const thrust = trailingReturn(B_THRUST_BARS);
    if (thrust !== null && thrust > B_THRUST) {
      mode = 'B';
      entrySeq = -1;
      entrySentSeq = seq;
      const notional = (state.cash * BigInt(Math.round(STAKE_FRACTION * 1000))) / 1000n;
      if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: BUY_SLIPPAGE_BPS }];
      }
      mode = null;
    }
  }
  return [];
}

// Exits are evaluated only while a position is open: take-profit,
// stop-loss, the trailing stop under the peak close, or the hold cap.
function exitOrders(state: BarsState): (BuyInput | SellInput)[] {
  const held = state.positions.get(SYMBOL);
  if (held === undefined || mode === null || entrySeq === -1 || entryPrice === 0) return [];
  const close = closes[closes.length - 1];
  if (close > peakClose) peakClose = close;
  const change = close / entryPrice - 1;
  const heldBars = state.seq - entrySeq;
  const tp = mode === 'A' ? A_TAKE_PROFIT : B_TAKE_PROFIT;
  const sl = mode === 'A' ? A_STOP_LOSS : B_STOP_LOSS;
  const trail = mode === 'A' ? A_TRAIL : B_TRAIL;
  const maxHold = mode === 'A' ? A_MAX_HOLD : B_MAX_HOLD;
  const exit =
    change >= tp ||
    change <= -sl ||
    heldBars >= maxHold ||
    close < peakClose * (1 - trail);
  if (!exit) return [];
  if (mode === 'A') cooldownAUntil = state.seq + A_COOLDOWN;
  else cooldownBUntil = state.seq + B_COOLDOWN;
  return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: SELL_SLIPPAGE_BPS }];
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) pushClose(Number(bar.c));
    }
    noteFills(state, batch);
    if (state.warmingUp) return [];
    if (closes.length < WARMUP_BARS) return [];
    if (state.positions.has(SYMBOL)) return exitOrders(state);
    if (mode !== null) {
      // An entry order is in flight and fills at the next open. If two
      // batches pass with no position, the market rejected it (slippage
      // cap or no bar): drop the pending mode so a fresh signal can fire
      // instead of waiting on a fill that will never come.
      if (entrySentSeq !== -1 && state.seq > entrySentSeq + 1) {
        mode = null;
        entrySentSeq = -1;
      } else {
        return [];
      }
    }
    return entryOrders(state);
  },
});
