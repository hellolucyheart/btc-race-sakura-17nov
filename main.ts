// Sakura BTC Racer, 17 November race edition: a long-only trading bot
// for cbBTC on the agent-fun/bars-replay/v1 protocol (one bar a minute).
//
// A single round trip burns roughly 26 bps once fees, slippage and the
// order's own price impact are added up, so this bot is deliberately
// picky: it only spends cash on moves that are far larger than that cost.
//
//   Mode A, the washout bounce: a panic flush arms the mode when the
//     close trades at least 1.8% beneath its EMA(120) while RSI(14) sits
//     at 35 or lower and the last 20 bars lost more than 1.2%. The mode
//     then stays armed for 90 bars, tracking the lowest close of the
//     flush, and buys only after price has climbed half a percent off
//     that low on a rising bar, so it never grabs the falling knife.
//     The position leaves on a 0.8% trailing stop below its best close,
//     at +4% profit, at -3% loss, or after 720 bars at the latest.
//
//   Mode B, the trend thrust: while the close holds above EMA(120), a
//     ten-bar gain beyond +1.2% is treated as momentum ignition and the
//     bot rides it. That position leaves on a tighter 0.6% trailing
//     stop, at +4% profit, at -1.8% loss, or after 240 bars.
//
//   Risk comes first: each entry stakes 90% of the cash on hand, every
//   exit starts a per-mode cooldown, and a kill switch blocks all new
//   entries once equity slips 3.5% under the 1,000 USDC starting line.
//   The dev gate only asks for any profit at all, and the live race is
//   ranked purely by net PnL, so keeping capital intact beats trading
//   often. One open position at a time, long only, never short.
//
// Every indicator is float64 arithmetic (add, subtract, multiply,
// divide) over the closes observed so far, which makes the bot fully
// deterministic: the same bars always produce the same orders, byte
// for byte. It reads no clock, no environment and no randomness.
// Adapted for the 17 Nov 2026 race from the 15 Nov Sakura BTC Racer.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- parameters shared by both modes -----------------------------------
const STAKE_FRACTION = 0.9; // fraction of free cash staked per entry
const KILL_DRAWDOWN = 0.035; // equity floor: start * (1 - this) blocks entries
const BUY_SLIPPAGE_BPS = 200; // a buy may chase price 2% beyond the close
const SELL_SLIPPAGE_BPS = 300; // a sell may concede 3% beyond the close

// --- Mode A constants: the washout bounce -------------------------------
const A_DEV = 0.018; // how far under EMA(120) the close must sit to arm
const A_RSI_MAX = 35; // RSI(14) ceiling for arming, inclusive
const A_DROP_BARS = 20; // lookback, in bars, of the flush's return
const A_DROP = -0.012; // that return must be worse than -1.2%
const A_ARM_BARS = 90; // bars an armed Mode A stays live
const A_CONFIRM = 0.005; // required bounce off the flush low before buying
const A_TAKE_PROFIT = 0.04;
const A_STOP_LOSS = 0.03;
const A_TRAIL = 0.008; // trailing stop under the peak close
const A_MAX_HOLD = 720;
const A_COOLDOWN = 30;

// --- Mode B constants: the trend thrust ---------------------------------
const B_THRUST_BARS = 10; // lookback, in bars, of the thrust's return
const B_THRUST = 0.012; // that return must beat +1.2% with price over EMA(120)
const B_TAKE_PROFIT = 0.04;
const B_STOP_LOSS = 0.018;
const B_TRAIL = 0.006;
const B_MAX_HOLD = 240;
const B_COOLDOWN = 60;

const EMA_SPAN = 120;
const RSI_SPAN = 14;
const WARMUP_BARS = 130; // first bar whose EMA/RSI values are trusted

// --- running indicator state (EMA(120) and RSI(14) over closes) ----------
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

// --- open-position and signal state ---------------------------------------
type Mode = 'A' | 'B';
let mode: Mode | null = null; // which mode owns the pending or open trade
let entryPrice = 0; // actual fill price of the open position, raw units
let entrySeq = -1; // batch seq at which the entry filled
let peakClose = 0; // highest close printed since the entry filled
let armedUntil = -1; // last seq at which an armed Mode A may still trigger
let flushLow = 0; // lowest close of the flush that armed Mode A
let entrySentSeq = -1; // seq at which the in-flight entry order was decided
let cooldownAUntil = -1; // Mode A may not signal again before this seq
let cooldownBUntil = -1; // Mode B may not signal again before this seq
let startEquity: bigint | null = null; // equity of the very first batch seen

function noteFills(state: BarsState, batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
    if (fill.side === 'buy' && mode !== null && entrySeq === -1) {
      entryPrice = Number(fill.price);
      entrySeq = batch.seq;
      peakClose = closes.length > 0 ? closes[closes.length - 1] : entryPrice;
    }
  }
  if (!state.positions.has(SYMBOL) && mode !== null && entrySeq !== -1) {
    mode = null;
    entrySeq = -1;
    entryPrice = 0;
    peakClose = 0;
  }
}

function entryOrders(state: BarsState): (BuyInput | SellInput)[] {
  if (startEquity === null) startEquity = state.equity; // latch the starting equity once
  if (state.equity * 1000n < startEquity * 965n) return []; // kill switch tripped: stay flat
  const close = closes[closes.length - 1];
  const seq = state.seq;
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

// Exit logic, consulted only while a position is open. A position is
// sold in full when any of these fires: the mode's take-profit level,
// its stop-loss level, the trailing stop beneath the best close since
// entry, or the mode's maximum holding time in bars.
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
