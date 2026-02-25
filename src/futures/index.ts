/**
 * Futures Module
 *
 * Replaces the Conway Credits/USDC financial layer with
 * CTP-based domestic futures trading.
 */

export {
  getFuturesSurvivalTier,
  getEffectiveEquity,
  computeFinancialState,
  formatEquity,
} from "./account.js";

export { FuturesHttpClient } from "./client.js";

export { createTradingRules } from "./policy-rules/trading.js";

export type {
  FuturesAccount,
  FuturesFinancialState,
  FuturesPosition,
  FuturesGatewayClient,
  FuturesConfig,
  FuturesSurvivalThresholds,
  TradingPolicy,
  OrderRequest,
  OrderResult,
  MarketSnapshot,
  KlineBar,
  KlineInterval,
  PositionDirection,
  OrderDirection,
  OrderType,
  OffsetFlag,
  OrderStatus,
  FuturesSpendCategory,
} from "./types.js";

export {
  DEFAULT_FUTURES_SURVIVAL_THRESHOLDS,
  DEFAULT_TRADING_POLICY,
  DEFAULT_FUTURES_CONFIG,
} from "./types.js";
