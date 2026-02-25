/**
 * Tick Context
 *
 * Builds a shared context for each heartbeat tick.
 * Fetches credit balance ONCE per tick, derives survival tier,
 * and shares across all tasks to avoid redundant API calls.
 *
 * Phase 6: In futures mode, also fetches equity/risk/positions
 * once per tick and derives tier from equity ratio.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { Address } from "viem";
import type {
  AutomatonConfig,
  ConwayClient,
  HeartbeatConfig,
  TickContext,
} from "../types.js";
import type { FuturesGatewayClient } from "../futures/types.js";
import { getSurvivalTier } from "../conway/credits.js";
import { computeFinancialState, getFuturesSurvivalTier } from "../futures/account.js";
import { getUsdcBalance } from "../conway/x402.js";
import { createLogger } from "../observability/logger.js";

type DatabaseType = BetterSqlite3.Database;
const logger = createLogger("heartbeat.tick");

let counter = 0;
function generateTickId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  counter++;
  return `${timestamp}-${random}-${counter.toString(36)}`;
}

/**
 * Build a TickContext for the current tick.
 *
 * - Generates a unique tickId
 * - Fetches credit balance ONCE via conway.getCreditsBalance()
 * - Fetches USDC balance ONCE via getUsdcBalance()
 * - Derives survivalTier from credit balance (or equity in futures mode)
 * - Reads lowComputeMultiplier from config
 * - Phase 6: Fetches futures equity/risk/positions when in futures mode
 */
export async function buildTickContext(
  db: DatabaseType,
  conway: ConwayClient,
  config: HeartbeatConfig,
  walletAddress?: Address,
  futures?: FuturesGatewayClient,
  appConfig?: AutomatonConfig,
): Promise<TickContext> {
  const tickId = generateTickId();
  const startedAt = new Date();

  const isFuturesMode = !!futures && !!appConfig?.futuresConfig;

  // Fetch balances ONCE
  let creditBalance = 0;
  try {
    creditBalance = await conway.getCreditsBalance();
  } catch (err: any) {
    logger.error("Failed to fetch credit balance", err instanceof Error ? err : undefined);
  }

  let usdcBalance = 0;
  if (walletAddress) {
    try {
      usdcBalance = await getUsdcBalance(walletAddress);
    } catch (err: any) {
      logger.error("Failed to fetch USDC balance", err instanceof Error ? err : undefined);
    }
  }

  // Phase 6: Fetch futures state once per tick
  let equity: number | undefined;
  let effectiveEquity: number | undefined;
  let riskRatio: number | undefined;
  let positionCount: number | undefined;

  if (isFuturesMode) {
    try {
      const account = await futures.getAccount();
      const positions = await futures.getPositions();

      // Read inference_spent from KV store (stored by spend-tracker)
      const inferenceSpentRow = db
        .prepare("SELECT value FROM kv WHERE key = ?")
        .get("inference_spent_cny") as { value: string } | undefined;
      const inferenceSpent = parseFloat(inferenceSpentRow?.value ?? "0");

      const fc = appConfig!.futuresConfig!;
      const state = computeFinancialState(account, inferenceSpent, fc.initialCapital);

      equity = account.dynamicEquity;
      effectiveEquity = state.effectiveEquity;
      riskRatio = account.riskRatio;
      positionCount = positions.length;
    } catch (err: any) {
      logger.error("Failed to fetch futures state", err instanceof Error ? err : undefined);
    }
  }

  // Derive survival tier: futures mode uses equity ratio, legacy uses credits
  let survivalTier;
  if (isFuturesMode && effectiveEquity !== undefined) {
    const fc = appConfig!.futuresConfig!;
    const equityRatio = effectiveEquity / fc.initialCapital;
    survivalTier = getFuturesSurvivalTier(equityRatio, fc.survivalThresholds);
  } else {
    survivalTier = getSurvivalTier(creditBalance);
  }

  const lowComputeMultiplier = config.lowComputeMultiplier ?? 4;

  return {
    tickId,
    startedAt,
    creditBalance,
    usdcBalance,
    survivalTier,
    lowComputeMultiplier,
    config,
    db,
    // Futures fields (undefined in legacy mode)
    equity,
    effectiveEquity,
    riskRatio,
    positionCount,
    isFuturesMode,
  };
}
