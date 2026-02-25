/**
 * Futures Trading Types
 *
 * Replaces the Conway Credits / USDC financial layer with
 * CTP-based futures trading on domestic Chinese exchanges.
 *
 * The agent's survival is driven by futures account equity
 * instead of cryptocurrency balances.
 */

// ─── Account ────────────────────────────────────────────────────

/**
 * Snapshot of a futures trading account.
 * Maps to CTP's TradingAccount query result.
 */
export interface FuturesAccount {
  /** Static equity (balance before today's P&L) */
  staticEquity: number;
  /** Dynamic equity = staticEquity + floatingPnl */
  dynamicEquity: number;
  /** Available margin (can open new positions) */
  available: number;
  /** Margin currently occupied by open positions */
  margin: number;
  /** Unrealized P&L from open positions */
  floatingPnl: number;
  /** Realized P&L from today's closed trades */
  todayPnl: number;
  /** Risk ratio = margin / dynamicEquity (0.0-1.0) */
  riskRatio: number;
  /** Timestamp of this snapshot */
  timestamp: string;
}

/**
 * Effective financial state: combines futures account with inference costs.
 * This is what the survival system uses for tier decisions.
 */
export interface FuturesFinancialState {
  /** Raw account from CTP gateway */
  account: FuturesAccount;
  /** Cumulative inference cost deducted from equity (in CNY) */
  inferenceSpent: number;
  /** Effective equity = dynamicEquity - inferenceSpent */
  effectiveEquity: number;
  /** Ratio of effective equity to initial capital (0.0-N) */
  equityRatio: number;
  /** Initial capital baseline */
  initialCapital: number;
  /** When this state was computed */
  lastChecked: string;
}

// ─── Positions ──────────────────────────────────────────────────

export type PositionDirection = "long" | "short";

export interface FuturesPosition {
  /** Instrument ID, e.g. "IF2403", "rb2405" */
  instrumentId: string;
  /** Instrument display name */
  instrumentName: string;
  /** Long or short */
  direction: PositionDirection;
  /** Number of contracts */
  volume: number;
  /** Average open price */
  openPrice: number;
  /** Current market price */
  currentPrice: number;
  /** Unrealized P&L for this position */
  floatingPnl: number;
  /** Margin occupied */
  margin: number;
  /** When was this position opened */
  openDate: string;
}

// ─── Orders ─────────────────────────────────────────────────────

export type OrderDirection = "buy" | "sell";
export type OrderType = "market" | "limit";
export type OffsetFlag = "open" | "close" | "close_today";
export type OrderStatus =
  | "pending"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected";

export interface OrderRequest {
  /** Instrument ID, e.g. "IF2403" */
  instrumentId: string;
  /** Buy or sell */
  direction: OrderDirection;
  /** Market or limit */
  orderType: OrderType;
  /** Open new or close existing */
  offset: OffsetFlag;
  /** Number of contracts */
  volume: number;
  /** Limit price (required for limit orders) */
  price?: number;
  /** Stop-loss price (optional) */
  stopLoss?: number;
  /** Take-profit price (optional) */
  takeProfit?: number;
}

export interface OrderResult {
  /** Whether the order was accepted by the exchange */
  success: boolean;
  /** Exchange-assigned order ID */
  orderId?: string;
  /** Reason for rejection if !success */
  error?: string;
  /** Current order status */
  status: OrderStatus;
  /** Filled volume so far */
  filledVolume: number;
  /** Average fill price */
  filledPrice: number;
  /** Timestamp */
  timestamp: string;
}

// ─── Market Data ────────────────────────────────────────────────

export interface MarketSnapshot {
  /** Instrument ID */
  instrumentId: string;
  /** Last trade price */
  lastPrice: number;
  /** Best bid price */
  bidPrice: number;
  /** Best bid volume */
  bidVolume: number;
  /** Best ask price */
  askPrice: number;
  /** Best ask volume */
  askVolume: number;
  /** Today's open price */
  openPrice: number;
  /** Today's high */
  highPrice: number;
  /** Today's low */
  lowPrice: number;
  /** Previous close */
  preClosePrice: number;
  /** Upper price limit */
  upperLimit: number;
  /** Lower price limit */
  lowerLimit: number;
  /** Today's total volume */
  volume: number;
  /** Today's turnover */
  turnover: number;
  /** Open interest */
  openInterest: number;
  /** Timestamp */
  timestamp: string;
}

export interface KlineBar {
  /** Bar open time */
  timestamp: string;
  /** Open price */
  open: number;
  /** High price */
  high: number;
  /** Low price */
  low: number;
  /** Close price */
  close: number;
  /** Volume */
  volume: number;
  /** Turnover */
  turnover: number;
}

export type KlineInterval =
  | "1m" | "5m" | "15m" | "30m"
  | "1h" | "4h"
  | "1d" | "1w";

// ─── Survival (Futures-based) ───────────────────────────────────

import type { SurvivalTier } from "../types.js";

/**
 * Futures survival thresholds based on equity ratio
 * (effectiveEquity / initialCapital).
 *
 * Example with 1,000,000 initial capital:
 *   high:        > 1.2  (> 1,200,000 = profitable)
 *   normal:      > 0.8  (> 800,000)
 *   low_compute: > 0.5  (> 500,000)
 *   critical:    > 0.2  (> 200,000)
 *   dead:        <= 0.2 (<= 200,000 or margin call)
 */
export interface FuturesSurvivalThresholds {
  /** Equity ratio above which tier = "high" */
  high: number;
  /** Equity ratio above which tier = "normal" */
  normal: number;
  /** Equity ratio above which tier = "low_compute" */
  low_compute: number;
  /** Equity ratio above which tier = "critical" */
  critical: number;
  // dead: anything <= critical threshold
}

export const DEFAULT_FUTURES_SURVIVAL_THRESHOLDS: FuturesSurvivalThresholds = {
  high: 1.2,
  normal: 0.8,
  low_compute: 0.5,
  critical: 0.2,
};

// ─── Trading Policy (replaces TreasuryPolicy) ───────────────────

export interface TradingPolicy {
  /** Max contracts per single instrument */
  maxPositionSize: number;
  /** Max number of instruments held simultaneously */
  maxTotalPositions: number;
  /** Max leverage multiplier */
  maxLeverage: number;
  /** Max single-trade loss as fraction of equity (0.0-1.0) */
  maxSingleLoss: number;
  /** Max daily loss as fraction of equity (0.0-1.0) */
  maxDailyLoss: number;
  /** Risk ratio at which to force-close positions */
  forceCloseAtRiskRatio: number;
  /** Daily inference budget in CNY */
  maxDailyInferenceCny: number;
  /** Max orders per turn */
  maxOrdersPerTurn: number;
  /** Instruments the agent is NOT allowed to trade */
  blockedInstruments: string[];
  /** Instruments the agent IS allowed to trade (empty = all allowed) */
  allowedInstruments: string[];
}

export const DEFAULT_TRADING_POLICY: TradingPolicy = {
  maxPositionSize: 10,
  maxTotalPositions: 3,
  maxLeverage: 5,
  maxSingleLoss: 0.05,
  maxDailyLoss: 0.10,
  forceCloseAtRiskRatio: 0.8,
  maxDailyInferenceCny: 500,
  maxOrdersPerTurn: 5,
  blockedInstruments: [],
  allowedInstruments: [],
};

// ─── CTP Gateway Client Interface ──────────────────────────────

/**
 * Interface for communicating with the CTP Gateway Python service.
 * Replaces ConwayClient's financial methods.
 */
export interface FuturesGatewayClient {
  /** Query account equity and margin state */
  getAccount(): Promise<FuturesAccount>;
  /** Query all open positions */
  getPositions(): Promise<FuturesPosition[]>;
  /** Place a new order */
  placeOrder(order: OrderRequest): Promise<OrderResult>;
  /** Cancel a pending order */
  cancelOrder(orderId: string): Promise<{ success: boolean; error?: string }>;
  /** Close a specific position (all volume or partial) */
  closePosition(
    instrumentId: string,
    direction: PositionDirection,
    volume?: number,
  ): Promise<OrderResult>;
  /** Close ALL open positions */
  closeAllPositions(): Promise<OrderResult[]>;
  /** Get latest market snapshot for an instrument */
  getMarketSnapshot(instrumentId: string): Promise<MarketSnapshot>;
  /** Get K-line data */
  getKline(
    instrumentId: string,
    interval: KlineInterval,
    limit?: number,
  ): Promise<KlineBar[]>;
  /** Get today's P&L summary */
  getPnl(): Promise<{
    todayPnl: number;
    floatingPnl: number;
    totalPnl: number;
  }>;
  /** Check if CTP gateway is connected and healthy */
  isConnected(): Promise<boolean>;
}

// ─── Futures Configuration ──────────────────────────────────────

export interface FuturesConfig {
  /** CTP Gateway REST API base URL */
  gatewayUrl: string;
  /** Initial simulated capital (CNY) */
  initialCapital: number;
  /** Survival thresholds */
  survivalThresholds: FuturesSurvivalThresholds;
  /** Trading risk policy */
  tradingPolicy: TradingPolicy;
  /** CTP broker ID */
  brokerId?: string;
  /** CTP user ID (SimNow investor code) */
  userId?: string;
  /** Whether to use OpenCTP TTS instead of SimNow */
  useOpenCtp?: boolean;
}

export const DEFAULT_FUTURES_CONFIG: Partial<FuturesConfig> = {
  gatewayUrl: "http://127.0.0.1:8400",
  initialCapital: 1_000_000,
  survivalThresholds: DEFAULT_FUTURES_SURVIVAL_THRESHOLDS,
  tradingPolicy: DEFAULT_TRADING_POLICY,
  useOpenCtp: true,
};

// ─── Spend category extension ───────────────────────────────────

/**
 * Extended spend categories for futures mode.
 * 'trading' replaces 'transfer' and 'x402'.
 */
export type FuturesSpendCategory = "inference" | "trading" | "commission" | "other";
