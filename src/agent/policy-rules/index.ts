/**
 * Policy Rules Registry
 *
 * Central registry for all policy rules. Aggregates rules from
 * each sub-phase module.
 *
 * Phase 7: Adds createFuturesDefaultRules() which swaps financial
 * rules for trading rules when in futures mode.
 */

import type { PolicyRule, TreasuryPolicy } from "../../types.js";
import { DEFAULT_TREASURY_POLICY } from "../../types.js";
import type { TradingPolicy } from "../../futures/types.js";
import { DEFAULT_TRADING_POLICY } from "../../futures/types.js";
import { createValidationRules } from "./validation.js";
import { createCommandSafetyRules } from "./command-safety.js";
import { createPathProtectionRules } from "./path-protection.js";
import { createFinancialRules } from "./financial.js";
import { createTradingRules } from "../../futures/policy-rules/trading.js";
import { createAuthorityRules } from "./authority.js";
import { createRateLimitRules } from "./rate-limits.js";

/**
 * Create the default set of policy rules (legacy credit mode).
 * Each sub-phase adds its rules here.
 */
export function createDefaultRules(
  treasuryPolicy: TreasuryPolicy = DEFAULT_TREASURY_POLICY,
): PolicyRule[] {
  return [
    ...createValidationRules(),
    ...createCommandSafetyRules(),
    ...createPathProtectionRules(),
    ...createFinancialRules(treasuryPolicy),
    ...createAuthorityRules(),
    ...createRateLimitRules(),
  ];
}

/**
 * Create the default set of policy rules for futures mode.
 * Replaces financial rules with trading rules; all other rules
 * (validation, command safety, path protection, authority, rate limits)
 * remain unchanged.
 */
export function createFuturesDefaultRules(
  tradingPolicy: TradingPolicy = DEFAULT_TRADING_POLICY,
): PolicyRule[] {
  return [
    ...createValidationRules(),
    ...createCommandSafetyRules(),
    ...createPathProtectionRules(),
    ...createTradingRules(tradingPolicy),
    ...createAuthorityRules(),
    ...createRateLimitRules(),
  ];
}
