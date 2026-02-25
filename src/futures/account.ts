/**
 * Futures Account Module
 *
 * Replaces conway/credits.ts.
 * Determines survival tier based on futures account equity ratio
 * instead of USDC/credit balances.
 */

import type { SurvivalTier } from "../types.js";
import type {
  FuturesAccount,
  FuturesFinancialState,
  FuturesSurvivalThresholds,
} from "./types.js";

/**
 * Determine the survival tier based on equity ratio.
 * equityRatio = effectiveEquity / initialCapital
 *
 * Thresholds are checked in descending order.
 * Boundary: the value must be strictly greater than the threshold.
 */
export function getFuturesSurvivalTier(
  equityRatio: number,
  thresholds: FuturesSurvivalThresholds,
): SurvivalTier {
  if (equityRatio > thresholds.high) return "high";
  if (equityRatio > thresholds.normal) return "normal";
  if (equityRatio > thresholds.low_compute) return "low_compute";
  if (equityRatio > thresholds.critical) return "critical";
  return "dead";
}

/**
 * Calculate effective equity by deducting cumulative inference costs.
 */
export function getEffectiveEquity(
  dynamicEquity: number,
  inferenceSpent: number,
): number {
  return dynamicEquity - inferenceSpent;
}

/**
 * Build a complete financial state snapshot for the survival system.
 */
export function computeFinancialState(
  account: FuturesAccount,
  inferenceSpent: number,
  initialCapital: number,
): FuturesFinancialState {
  const effectiveEquity = getEffectiveEquity(account.dynamicEquity, inferenceSpent);
  const equityRatio = initialCapital > 0
    ? effectiveEquity / initialCapital
    : 0;

  return {
    account,
    inferenceSpent,
    effectiveEquity,
    equityRatio,
    initialCapital,
    lastChecked: new Date().toISOString(),
  };
}

/**
 * Format equity amount in CNY for display.
 */
export function formatEquity(amount: number): string {
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (amount < 0) return `-¥${formatted}`;
  return `¥${formatted}`;
}
