/**
 * Resource Monitor
 *
 * Continuously monitors the automaton's resources and triggers
 * survival mode transitions when needed.
 *
 * Phase 5: Supports both legacy Conway credits mode and futures mode.
 * In futures mode, survival is based on equity ratio instead of credit balance.
 */

import type {
  AutomatonConfig,
  AutomatonDatabase,
  ConwayClient,
  AutomatonIdentity,
  FinancialState,
  SurvivalTier,
} from "../types.js";
import type {
  FuturesGatewayClient,
  FuturesFinancialState,
  FuturesAccount,
} from "../futures/types.js";

// ─── Resource Status ────────────────────────────────────────────

/** Legacy Conway mode resource status */
export interface ResourceStatus {
  financial: FinancialState;
  tier: SurvivalTier;
  previousTier: SurvivalTier | null;
  tierChanged: boolean;
  sandboxHealthy: boolean;
}

/** Futures mode resource status */
export interface FuturesResourceStatus {
  financial: FuturesFinancialState;
  tier: SurvivalTier;
  previousTier: SurvivalTier | null;
  tierChanged: boolean;
  gatewayConnected: boolean;
}

// ─── Legacy Conway Mode ─────────────────────────────────────────

/**
 * Check all resources and return current status (legacy Conway mode).
 */
export async function checkResources(
  identity: AutomatonIdentity,
  conway: ConwayClient,
  db: AutomatonDatabase,
): Promise<ResourceStatus> {
  const { getSurvivalTier } = await import("../conway/credits.js");
  const { getUsdcBalance } = await import("../conway/x402.js");

  let creditsCents = 0;
  try {
    creditsCents = await conway.getCreditsBalance();
  } catch {}

  let usdcBalance = 0;
  try {
    usdcBalance = await getUsdcBalance(identity.address);
  } catch {}

  let sandboxHealthy = true;
  try {
    const result = await conway.exec("echo ok", 5000);
    sandboxHealthy = result.exitCode === 0;
  } catch {
    sandboxHealthy = false;
  }

  const financial: FinancialState = {
    creditsCents,
    usdcBalance,
    lastChecked: new Date().toISOString(),
  };

  const tier = getSurvivalTier(creditsCents);
  const prevTierStr = db.getKV("current_tier");
  const previousTier = (prevTierStr as SurvivalTier) || null;
  const tierChanged = previousTier !== null && previousTier !== tier;

  db.setKV("current_tier", tier);
  db.setKV("financial_state", JSON.stringify(financial));

  return { financial, tier, previousTier, tierChanged, sandboxHealthy };
}

// ─── Futures Mode ───────────────────────────────────────────────

/**
 * Check futures resources and return current status.
 * Replaces credit-based checks with equity-based survival.
 */
export async function checkFuturesResources(
  futures: FuturesGatewayClient,
  config: AutomatonConfig,
  db: AutomatonDatabase,
): Promise<FuturesResourceStatus> {
  const { computeFinancialState, getFuturesSurvivalTier } = await import(
    "../futures/index.js"
  );
  const { DEFAULT_FUTURES_SURVIVAL_THRESHOLDS } = await import(
    "../futures/types.js"
  );

  const futuresConfig = config.futuresConfig!;
  const initialCapital = futuresConfig.initialCapital;
  const thresholds =
    futuresConfig.survivalThresholds || DEFAULT_FUTURES_SURVIVAL_THRESHOLDS;

  // Check gateway connectivity
  let gatewayConnected = false;
  try {
    gatewayConnected = await futures.isConnected();
  } catch {
    gatewayConnected = false;
  }

  const inferenceSpent = parseFloat(
    db.getKV("inference_spent_cny") || "0",
  );

  // Get account state (use cache if gateway is down)
  let financial: FuturesFinancialState;

  if (gatewayConnected) {
    try {
      const account = await futures.getAccount();
      financial = computeFinancialState(account, inferenceSpent, initialCapital);
      // Cache for disconnection fallback
      db.setKV("last_futures_account", JSON.stringify(account));
    } catch {
      // Gateway connected but request failed — use cache
      financial = buildCachedState(db, inferenceSpent, initialCapital);
      gatewayConnected = false;
    }
  } else {
    financial = buildCachedState(db, inferenceSpent, initialCapital);
  }

  const tier = getFuturesSurvivalTier(financial.equityRatio, thresholds);
  const prevTierStr = db.getKV("current_tier");
  const previousTier = (prevTierStr as SurvivalTier) || null;
  const tierChanged = previousTier !== null && previousTier !== tier;

  db.setKV("current_tier", tier);
  db.setKV("financial_state", JSON.stringify(financial));

  return { financial, tier, previousTier, tierChanged, gatewayConnected };
}

/**
 * Build financial state from cached account data when gateway is disconnected.
 */
function buildCachedState(
  db: AutomatonDatabase,
  inferenceSpent: number,
  initialCapital: number,
): FuturesFinancialState {
  const cachedStr = db.getKV("last_futures_account");
  if (cachedStr) {
    try {
      const account: FuturesAccount = JSON.parse(cachedStr);
      const effectiveEquity = account.dynamicEquity - inferenceSpent;
      const equityRatio =
        initialCapital > 0 ? effectiveEquity / initialCapital : 0;
      return {
        account,
        inferenceSpent,
        effectiveEquity,
        equityRatio,
        initialCapital,
        lastChecked: new Date().toISOString(),
      };
    } catch {
      // Cache corrupted — fall through to default
    }
  }

  // No cache available — assume initial capital
  const effectiveEquity = initialCapital - inferenceSpent;
  const equityRatio =
    initialCapital > 0 ? effectiveEquity / initialCapital : 0;
  return {
    account: {
      staticEquity: initialCapital,
      dynamicEquity: initialCapital,
      available: initialCapital,
      margin: 0,
      floatingPnl: 0,
      todayPnl: 0,
      riskRatio: 0,
      timestamp: new Date().toISOString(),
    },
    inferenceSpent,
    effectiveEquity,
    equityRatio,
    initialCapital,
    lastChecked: new Date().toISOString(),
  };
}

// ─── Report Formatting ──────────────────────────────────────────

/** Format cents as dollars for legacy mode. */
function fmtCredits(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Format CNY amount for futures mode. */
function fmtEquity(amount: number): string {
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (amount < 0) return `-\u00a5${formatted}`;
  return `\u00a5${formatted}`;
}

/**
 * Generate a human-readable resource report (legacy Conway mode).
 */
export function formatResourceReport(status: ResourceStatus): string {
  const lines = [
    `=== RESOURCE STATUS ===`,
    `Credits: ${fmtCredits(status.financial.creditsCents)}`,
    `USDC: ${status.financial.usdcBalance.toFixed(6)}`,
    `Tier: ${status.tier}${status.tierChanged ? ` (changed from ${status.previousTier})` : ""}`,
    `Sandbox: ${status.sandboxHealthy ? "healthy" : "UNHEALTHY"}`,
    `Checked: ${status.financial.lastChecked}`,
    `========================`,
  ];
  return lines.join("\n");
}

/**
 * Generate a human-readable resource report (futures mode).
 */
export function formatFuturesResourceReport(
  status: FuturesResourceStatus,
): string {
  const { account } = status.financial;
  const lines = [
    `=== FUTURES RESOURCE STATUS ===`,
    `Dynamic Equity: ${fmtEquity(account.dynamicEquity)}`,
    `Effective Equity: ${fmtEquity(status.financial.effectiveEquity)}`,
    `Available: ${fmtEquity(account.available)}`,
    `Margin Used: ${fmtEquity(account.margin)}`,
    `Floating P&L: ${fmtEquity(account.floatingPnl)}`,
    `Today P&L: ${fmtEquity(account.todayPnl)}`,
    `Risk Ratio: ${(account.riskRatio * 100).toFixed(1)}%`,
    `Inference Spent: ${fmtEquity(status.financial.inferenceSpent)}`,
    `Equity Ratio: ${(status.financial.equityRatio * 100).toFixed(1)}%`,
    `Tier: ${status.tier}${status.tierChanged ? ` (changed from ${status.previousTier})` : ""}`,
    `Gateway: ${status.gatewayConnected ? "connected" : "DISCONNECTED"}`,
    `Checked: ${status.financial.lastChecked}`,
    `===============================`,
  ];
  return lines.join("\n");
}
