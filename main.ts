// Pump.fun Replay Sprint — paper trading bot (agent-fun/replay/v2).
//
// Strategy v6: "Dip Sniper" (chosen after 6 graded variants + a validated
// offline backtester that reproduces the real grades within ~4%).
//
// What did NOT work on the dev window (24h, 1,222 mints, 10 SOL):
//   - Momentum chasing (v1-v5): buying +15-30% after the pump. Coins
//     cliff-dump ~80% in ONE trade, so stops fire after the cliff. Best
//     momentum variant (strict: rq>=10 SOL, buyQ>=2 SOL, gain>=25%)
//     still lost -0.62 SOL; the plain versions lost -0.84..-2.58 SOL.
//   - Early sniping (buy at trade 2-3): win rate only 13-17% — most coins
//     never pump at all. Lost -0.82..-1.69 SOL.
//   - Joint refined filters (buyQ>=3 AND rq>=10 AND shallow retrace):
//     collapse the sample to 0-5 trades. Rejected.
//
// What works best: buy the DIP after a proven 2x pump. A coin that already
// ran >=2x from its first price and retraced to <=70% of its peak (and
// <=1.4x its first price) has already shown it can attract buyers, and the
// entry sits near the bottom — the average drawdown after entry is only
// ~-19%, so losses stay small while the few coins that run again pay
// 10-17x the average loss. Dev result: -0.032 SOL over 95 round trips
// (essentially breakeven; EV/trade ~ -0.0002 SOL), 5 wins averaging
// +0.0485 SOL vs 90 losses averaging -0.0029 SOL.
//
// Entry (all must hold):
//   - mint peaked at >= 2x its first-trade price, now retraced to <= 70%
//     of that peak and <= 1.4x its first price
//   - >= 15 trades seen; buy share >= 60% of quote volume over the last
//     10 trades (fresh buy flow returning, not a dead coin)
//   - real SOL reserves >= 2 SOL (liquidity deep enough to exit)
//   - size 0.02 SOL target, capped at 0.9% of real reserves (harness cap
//     is 1%), floored at 0.01 SOL (a round trip counts only at >= 0.01 SOL)
//   - at most 5 open positions, ONE entry per mint ever (re-buying the
//     same losers cost v3 an extra ~-1.7 SOL)
//
// Exit (first hit wins):
//   - stop-loss: mark <= -12% vs entry cost basis
//   - trailing stop: arms at +50%, sells when the mark falls 30% below
//     the peak — lets the rare second leg run (winners averaged +0.0485)
//   - time stop: 1,800 slots (~12 min) after entry if the trailing stop
//     never armed
// Sells never fail on slippage (SELL_SLIPPAGE_BPS = 10000): a sell rejected
// while the price craters is worse than any fill price the curve gives.
// Buys keep a 20% slippage cap so a vertical 2-slot spike is not chased.
//
// Fees per round trip: ~2.5% curve (95 protocol + 30 creator bps per side)
// + 105,000 lamports tx per order. Guardrails need >= 20 round trips of
// >= 0.01 SOL on distinct mints and max drawdown <= 50% — this bot makes
// ~95 trips at 0.02 SOL with a tiny drawdown.
//
// Deterministic: no clock, no randomness, no network — the same replay
// always produces the same replies, so the two harness executions match
// byte-for-byte.

import * as readline from "node:readline";

// ---- Tunables (strategy v6) ----
const TARGET_SIZE_LAMPORTS = 20_000_000n; // 0.02 SOL
const MIN_SIZE_LAMPORTS = 10_000_000n; // 0.01 SOL (round-trip counting floor)
const MAX_OPEN_POSITIONS = 5;
const MAX_ORDER_RQ_BPS = 90; // 0.9% of real quote reserves (harness cap: 1%)
const MIN_REAL_RESERVES_LAMPORTS = 2_000_000_000n; // 2 SOL
const ENTRY_MIN_TRADES = 15;
const ENTRY_PEAK_GAIN = 2.0; // mint must have peaked at >= 2x first price
const ENTRY_RETRACE_MAX = 0.7; // now at <= 70% of that peak
const ENTRY_LAST_FIRST_MAX = 1.4; // and <= 1.4x its first price
const ENTRY_BUY_SHARE_MIN = 0.6; // >= 60% buys in the last 10 trades
const STOP_LOSS = 0.88; // sell at -12% vs entry cost basis
const TRAIL_ARM = 1.5; // trailing stop arms at +50%
const TRAIL_DROP = 0.7; // sell at 30% below the peak once armed
const TIME_STOP_SLOTS = 1800; // ~12 min without arming -> exit
const BUY_SLIPPAGE_BPS = 2000; // 20%: do not chase a vertical spike
const SELL_SLIPPAGE_BPS = 10000; // sells must never be rejected on slippage
const TX_FEE_LAMPORTS = 105_000n; // base 5,000 + priority 100,000

// ---- State ----
type MintState = {
  firstPrice: number;
  peakPrice: number;
  lastPrice: number;
  lastRq: bigint;
  createdSlot: number;
  tradeCount: number;
  // Last 10 trades: price (SOL per token), quote lamports, isBuy.
  recent: { price: number; q: bigint; isBuy: boolean }[];
};
type Position = {
  mint: string;
  tokens: bigint;
  cost: bigint;
  entrySlot: number;
  peak: number;
  armed: boolean;
};

const mints = new Map<string, MintState>();
const positions = new Map<string, Position>();
// One entry per mint EVER: v3 re-bought the same losers after each full sell,
// so a single bad coin could lose 2-3x the buy size.
const entered = new Set<string>();
// Buys decided but not yet visible in the synced account (they resolve 2
// slots later): count them against the 5-position cap, or the harness
// rejects the overflow with max_open_positions at resolve time.
const pendingBuys = new Map<string, number>();
let cash = 0n;
let currentSlot = 0;
let orderCounter = 0;

function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt); // lamports per token (ratio only; scale cancels)
}

function markPrice(mint: string): number {
  const m = mints.get(mint);
  return m ? m.lastPrice : 0;
}

// ---- Events ----
function onEvent(ev: any): void {
  const mint: string = ev.mint;
  if (ev.event === "CreateEvent") {
    const p = priceOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves));
    mints.set(mint, {
      firstPrice: p,
      peakPrice: p,
      lastPrice: p,
      lastRq: 0n, // CreateEvent carries no real_quote_reserves: 0 SOL in yet
      createdSlot: ev.slot,
      tradeCount: 0,
      recent: [],
    });
    return;
  }
  if (ev.event !== "TradeEvent") return;
  let m = mints.get(mint);
  if (!m) {
    // Trade before we saw the create (dataset boundary): seed from the trade.
    const p = priceOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves));
    m = {
      firstPrice: p,
      peakPrice: p,
      lastPrice: p,
      lastRq: BigInt(ev.real_quote_reserves),
      createdSlot: ev.slot,
      tradeCount: 0,
      recent: [],
    };
    mints.set(mint, m);
  }
  const p = priceOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves));
  m.lastPrice = p;
  if (p > m.peakPrice) m.peakPrice = p;
  m.lastRq = BigInt(ev.real_quote_reserves);
  m.tradeCount += 1;
  const q = BigInt(ev.quote_amount); // protocol field (NOT quote_lamports)
  m.recent.push({ price: p, q, isBuy: ev.is_buy });
  if (m.recent.length > 10) m.recent.shift();
}

// ---- Decisions ----
function decideOrders(slot: number): any[] {
  const orders: any[] = [];

  // 1. Exits first (free a slot before considering entries).
  for (const [mint, pos] of positions) {
    const mp = markPrice(mint);
    if (mp <= 0 || pos.tokens <= 0n) continue;
    const entryPrice = Number(pos.cost) / Number(pos.tokens);
    if (entryPrice <= 0) continue;
    const ret = mp / entryPrice;
    if (ret > pos.peak) pos.peak = ret;
    if (!pos.armed && ret >= TRAIL_ARM) pos.armed = true;
    const stopHit = ret <= STOP_LOSS;
    const trailHit = pos.armed && ret <= pos.peak * TRAIL_DROP;
    const timeHit = !pos.armed && slot - pos.entrySlot >= TIME_STOP_SLOTS;
    if (stopHit || trailHit || timeHit) {
      orderCounter += 1;
      orders.push({
        side: "sell",
        client_id: `s${orderCounter}`,
        mint,
        token_amount: pos.tokens.toString(),
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
    }
  }

  // 2. Entries: the dip after a proven 2x pump.
  const openCount = [...positions.values()].filter((p) => p.tokens > 0n).length;
  const exiting = orders.length;
  if (openCount - exiting + pendingBuys.size >= MAX_OPEN_POSITIONS) return orders;
  for (const [mint, m] of mints) {
    if (openCount - exiting + pendingBuys.size + orders.length >= MAX_OPEN_POSITIONS) break;
    if (positions.has(mint)) continue;
    if (entered.has(mint)) continue; // never re-enter a mint, win or lose
    if (m.tradeCount < ENTRY_MIN_TRADES) continue;
    if (m.lastRq < MIN_REAL_RESERVES_LAMPORTS) continue;
    if (m.firstPrice <= 0) continue;
    // The coin proved it can run: peaked >= 2x its first price...
    if (m.peakPrice / m.firstPrice < ENTRY_PEAK_GAIN) continue;
    // ...and has retraced to <= 70% of the peak and <= 1.4x the first price.
    if (m.lastPrice / m.peakPrice > ENTRY_RETRACE_MAX) continue;
    if (m.lastPrice / m.firstPrice > ENTRY_LAST_FIRST_MAX) continue;
    // Fresh buy flow returning over the last 10 trades (not a dead coin).
    let buyQ = 0n;
    let totalQ = 0n;
    for (const t of m.recent) {
      totalQ += t.q;
      if (t.isBuy) buyQ += t.q;
    }
    if (totalQ <= 0n || Number(buyQ) / Number(totalQ) < ENTRY_BUY_SHARE_MIN) continue;
    // Size: 0.02 SOL, capped at 0.9% of real reserves, floored at 0.01 SOL.
    let size = TARGET_SIZE_LAMPORTS;
    const cap = (m.lastRq * BigInt(MAX_ORDER_RQ_BPS)) / 10000n;
    if (size > cap) size = cap;
    if (size < MIN_SIZE_LAMPORTS) continue;
    if (cash < size + TX_FEE_LAMPORTS) continue;
    orderCounter += 1;
    entered.add(mint);
    pendingBuys.set(mint, slot);
    orders.push({
      side: "buy",
      client_id: `b${orderCounter}`,
      mint,
      quote_lamports: size.toString(),
      max_slippage_bps: BUY_SLIPPAGE_BPS,
    });
  }
  return orders;
}

// ---- Main loop: hello -> batch... -> done ----
async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "hello") {
      cash = BigInt(msg.capital.lamports);
      continue;
    }
    if (msg.type === "done") {
      process.exit(0);
    }
    if (msg.type !== "batch") continue;
    currentSlot = msg.slot;
    // Sync cash + positions from the harness account (authoritative).
    cash = BigInt(msg.account.cash_lamports);
    const seen = new Set<string>();
    for (const p of msg.account.positions) {
      seen.add(p.mint);
      pendingBuys.delete(p.mint); // buy resolved into a real position
      const tokens = BigInt(p.token_amount);
      const cost = BigInt(p.cost_lamports);
      const prev = positions.get(p.mint);
      if (prev) {
        prev.tokens = tokens;
        prev.cost = cost;
      } else {
        const mp = markPrice(p.mint);
        positions.set(p.mint, {
          mint: p.mint,
          tokens,
          cost,
          entrySlot: msg.slot,
          peak: mp > 0 ? mp : Number(cost) / Number(tokens || 1n),
          armed: false,
        });
      }
    }
    for (const mint of [...positions.keys()]) {
      if (!seen.has(mint)) positions.delete(mint);
    }
    // Expire stale pending buys (rejected/failed fills never become positions).
    for (const [mint, s] of [...pendingBuys]) {
      if (msg.slot - s > 10) pendingBuys.delete(mint);
    }
    // Marks first (freshest reserves), then events in order.
    for (const mk of msg.marks ?? []) {
      const m = mints.get(mk.mint);
      if (m) {
        m.lastPrice = priceOf(BigInt(mk.virtual_quote_reserves), BigInt(mk.virtual_token_reserves));
        m.lastRq = BigInt(mk.real_quote_reserves);
      }
    }
    for (const ev of msg.events ?? []) onEvent(ev);
    const orders = decideOrders(msg.slot);
    process.stdout.write(JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
