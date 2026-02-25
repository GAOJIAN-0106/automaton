/**
 * Low Compute Mode
 *
 * Manages transitions between survival tiers.
 * When resources run low, the automaton enters increasingly restricted modes.
 *
 * Phase 5: Adds futures-mode behavior to tier restrictions:
 * - critical: closes all positions via CTP gateway
 * - low_compute: restricts trading to first allowed instrument only
 */

import type {
  AutomatonConfig,
  AutomatonDatabase,
  InferenceClient,
  SurvivalTier,
} from "../types.js";
import type { FuturesGatewayClient } from "../futures/types.js";

export interface ModeTransition {
  from: SurvivalTier;
  to: SurvivalTier;
  timestamp: string;
  /** Credits in cents (legacy) or equity in CNY (futures) */
  creditsCents: number;
}

/**
 * Apply survival tier restrictions to the automaton.
 */
export function applyTierRestrictions(
  tier: SurvivalTier,
  inference: InferenceClient,
  db: AutomatonDatabase,
): void {
  switch (tier) {
    case "high":
    case "normal":
      inference.setLowComputeMode(false);
      break;

    case "low_compute":
    case "critical":
    case "dead":
      inference.setLowComputeMode(true);
      break;
  }

  db.setKV("current_tier", tier);
}

/**
 * Apply futures-specific tier restrictions.
 * Called in addition to applyTierRestrictions when in futures mode.
 *
 * - critical: close all positions immediately
 * - low_compute: restrict to first allowed instrument
 */
export async function applyFuturesTierRestrictions(
  tier: SurvivalTier,
  futures: FuturesGatewayClient,
  config: AutomatonConfig,
  db: AutomatonDatabase,
): Promise<void> {
  if (tier === "critical") {
    // Emergency: close all positions to prevent further loss
    try {
      const results = await futures.closeAllPositions();
      const closed = results.filter((r) => r.success).length;
      db.setKV(
        "tier_action_critical",
        JSON.stringify({
          action: "close_all_positions",
          closedCount: closed,
          totalCount: results.length,
          timestamp: new Date().toISOString(),
        }),
      );
    } catch {
      // Gateway may be down — record failure
      db.setKV(
        "tier_action_critical",
        JSON.stringify({
          action: "close_all_positions",
          error: "gateway_unavailable",
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }

  if (tier === "low_compute") {
    // Restrict trading to first allowed instrument only
    const policy = config.futuresConfig?.tradingPolicy;
    const allowed = policy?.allowedInstruments ?? [];
    if (allowed.length > 0) {
      db.setKV("restricted_instruments", JSON.stringify([allowed[0]]));
    }
  }

  if (tier === "high" || tier === "normal") {
    // Clear any trading restrictions
    db.deleteKV("restricted_instruments");
    db.deleteKV("tier_action_critical");
  }
}

/**
 * Record a tier transition.
 */
export function recordTransition(
  db: AutomatonDatabase,
  from: SurvivalTier,
  to: SurvivalTier,
  creditsCents: number,
): ModeTransition {
  const transition: ModeTransition = {
    from,
    to,
    timestamp: new Date().toISOString(),
    creditsCents,
  };

  const historyStr = db.getKV("tier_transitions") || "[]";
  const history: ModeTransition[] = JSON.parse(historyStr);
  history.push(transition);
  if (history.length > 50) {
    history.splice(0, history.length - 50);
  }
  db.setKV("tier_transitions", JSON.stringify(history));

  return transition;
}

/**
 * Check if the agent should be allowed to run inference in current tier.
 */
export function canRunInference(tier: SurvivalTier): boolean {
  return tier !== "dead";
}

/**
 * Get the model to use for the current tier.
 */
export function getModelForTier(
  tier: SurvivalTier,
  defaultModel: string,
): string {
  switch (tier) {
    case "high":
    case "normal":
      return defaultModel;
    case "low_compute":
    case "critical":
    case "dead":
      return "gpt-5-mini";
  }
}
