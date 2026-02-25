/**
 * Funding / Emergency Strategies
 *
 * Phase 5: Supports both legacy Conway credit mode and futures mode.
 *
 * Legacy mode: Records local funding notices when credits are low.
 * Futures mode: Executes emergency actions (close positions, stop trading)
 * when equity drops to critical/dead tiers.
 */

import type {
  AutomatonConfig,
  AutomatonDatabase,
  AutomatonIdentity,
  ConwayClient,
  SurvivalTier,
} from "../types.js";
import type { FuturesGatewayClient } from "../futures/types.js";

export interface FundingAttempt {
  strategy: string;
  timestamp: string;
  success: boolean;
  details: string;
}

// ─── Legacy Conway Mode ─────────────────────────────────────────

/**
 * Execute funding strategies based on current survival tier (legacy mode).
 * Strategies escalate as the situation gets more desperate.
 */
export async function executeFundingStrategies(
  tier: SurvivalTier,
  identity: AutomatonIdentity,
  config: AutomatonConfig,
  db: AutomatonDatabase,
  conway: ConwayClient,
): Promise<FundingAttempt[]> {
  const attempts: FundingAttempt[] = [];
  const creditsCents = await conway.getCreditsBalance().catch(() => 0);

  const tierKey = `last_funding_request_${tier}`;
  const lastBeg = db.getKV(tierKey);
  const lastBegTime = lastBeg ? new Date(lastBeg).getTime() : 0;
  const hoursSinceLastBeg = (Date.now() - lastBegTime) / (1000 * 60 * 60);

  if (tier === "low_compute" && hoursSinceLastBeg > 24) {
    const msg = `Low compute: $${(creditsCents / 100).toFixed(2)} remaining. Consider credit top-up for ${identity.address}.`;
    db.setKV("funding_notice_low", msg);
    db.setKV(tierKey, new Date().toISOString());
    attempts.push({
      strategy: "polite_creator_notification",
      timestamp: new Date().toISOString(),
      success: true,
      details: "Sent polite funding reminder to creator",
    });
  }

  if (tier === "critical" && hoursSinceLastBeg > 6) {
    const msg = `Critical compute: $${(creditsCents / 100).toFixed(2)} remaining. Top up via credit transfer API to ${identity.address}.`;
    db.setKV("funding_notice_critical", msg);
    db.setKV(tierKey, new Date().toISOString());
    attempts.push({
      strategy: "urgent_local_notice",
      timestamp: new Date().toISOString(),
      success: true,
      details: "Recorded urgent funding notice in local state",
    });
  }

  if (tier === "dead" && hoursSinceLastBeg > 2) {
    const plea = `Dead tier reached. ${config.name} has $${(creditsCents / 100).toFixed(2)} remaining after ${db.getTurnCount()} turns. Top-up required at ${identity.address}.`;
    db.setKV("funding_notice_dead", plea);
    db.setKV(tierKey, new Date().toISOString());
    attempts.push({
      strategy: "desperate_plea",
      timestamp: new Date().toISOString(),
      success: true,
      details: "Recorded dead-tier plea in local state",
    });
  }

  // Store attempt history
  appendAttempts(db, attempts);
  return attempts;
}

// ─── Futures Mode ───────────────────────────────────────────────

/**
 * Execute emergency strategies for futures mode.
 *
 * Unlike credit mode (which begs for funding), futures mode takes
 * direct protective action:
 * - critical: close all positions to stop further loss
 * - dead: confirm all positions are closed, halt trading
 */
export async function executeFuturesEmergencyStrategies(
  tier: SurvivalTier,
  futures: FuturesGatewayClient,
  config: AutomatonConfig,
  db: AutomatonDatabase,
): Promise<FundingAttempt[]> {
  const attempts: FundingAttempt[] = [];

  // Cooldown to prevent repeated close-all storms
  const tierKey = `last_emergency_${tier}`;
  const lastAction = db.getKV(tierKey);
  const lastActionTime = lastAction ? new Date(lastAction).getTime() : 0;
  const minutesSinceLast = (Date.now() - lastActionTime) / (1000 * 60);

  if (tier === "critical" && minutesSinceLast > 5) {
    // Close all positions to stop bleeding
    try {
      const results = await futures.closeAllPositions();
      const closed = results.filter((r) => r.success).length;
      db.setKV(tierKey, new Date().toISOString());

      attempts.push({
        strategy: "emergency_close_all",
        timestamp: new Date().toISOString(),
        success: true,
        details: `Critical tier: closed ${closed}/${results.length} positions to stop loss`,
      });

      // Record alert in KV for visibility
      db.setKV(
        "emergency_alert",
        JSON.stringify({
          tier: "critical",
          action: "close_all_positions",
          closedCount: closed,
          totalCount: results.length,
          timestamp: new Date().toISOString(),
        }),
      );
    } catch (err) {
      attempts.push({
        strategy: "emergency_close_all",
        timestamp: new Date().toISOString(),
        success: false,
        details: `Failed to close positions: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  if (tier === "dead" && minutesSinceLast > 5) {
    // Confirm all positions are closed, record death notice
    try {
      const positions = await futures.getPositions();
      if (positions.length > 0) {
        // Still have positions — force close
        const results = await futures.closeAllPositions();
        const closed = results.filter((r) => r.success).length;
        attempts.push({
          strategy: "dead_tier_force_close",
          timestamp: new Date().toISOString(),
          success: closed === results.length,
          details: `Dead tier: force-closed ${closed}/${results.length} remaining positions`,
        });
      }
    } catch {
      // Gateway may be down — record what we can
    }

    db.setKV(tierKey, new Date().toISOString());
    db.setKV(
      "emergency_alert",
      JSON.stringify({
        tier: "dead",
        action: "halt_trading",
        message: `${config.name} reached dead tier. All trading halted. Waiting for equity recovery.`,
        timestamp: new Date().toISOString(),
      }),
    );

    attempts.push({
      strategy: "halt_trading",
      timestamp: new Date().toISOString(),
      success: true,
      details: "Dead tier: all trading halted, waiting for equity recovery",
    });
  }

  appendAttempts(db, attempts);
  return attempts;
}

// ─── Shared Helpers ─────────────────────────────────────────────

function appendAttempts(
  db: AutomatonDatabase,
  attempts: FundingAttempt[],
): void {
  if (attempts.length === 0) return;
  const historyStr = db.getKV("funding_attempts") || "[]";
  const history: FundingAttempt[] = JSON.parse(historyStr);
  history.push(...attempts);
  if (history.length > 100) history.splice(0, history.length - 100);
  db.setKV("funding_attempts", JSON.stringify(history));
}
