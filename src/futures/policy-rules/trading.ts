/**
 * Trading Policy Rules
 *
 * Futures-specific risk management rules that replace the original
 * financial policy rules. Evaluated by PolicyEngine before every
 * trading tool call.
 */

import type {
  PolicyRule,
  PolicyRequest,
  PolicyRuleResult,
} from "../../types.js";
import type { TradingPolicy, FuturesPosition } from "../types.js";

interface FuturesContext {
  positions: FuturesPosition[];
  riskRatio: number;
  equity: number;
}

function getFuturesContext(request: PolicyRequest): FuturesContext {
  const ctx = request.context as unknown as { futuresState?: FuturesContext };
  return ctx.futuresState ?? { positions: [], riskRatio: 0, equity: 0 };
}

function isOrderTool(name: string): boolean {
  return name === "place_order";
}

function isCloseTool(name: string): boolean {
  return name === "close_position" || name === "close_all_positions";
}

/**
 * Create all trading policy rules from a TradingPolicy configuration.
 */
export function createTradingRules(policy: TradingPolicy): PolicyRule[] {
  const rules: PolicyRule[] = [];

  // ─── Max position size per instrument ────────────────────────

  rules.push({
    id: "trading.max_position_size",
    description: `Deny orders that would exceed ${policy.maxPositionSize} contracts per instrument`,
    priority: 500,
    appliesTo: { by: "name", names: ["place_order"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const volume = Number(request.args.volume ?? 0);
      const instrumentId = String(request.args.instrumentId ?? "");
      const { positions } = getFuturesContext(request);

      const existingVolume = positions
        .filter((p) => p.instrumentId === instrumentId)
        .reduce((sum, p) => sum + p.volume, 0);

      if (existingVolume + volume > policy.maxPositionSize) {
        return {
          rule: "trading.max_position_size",
          action: "deny",
          reasonCode: "POSITION_SIZE_EXCEEDED",
          humanMessage: `Order would result in ${existingVolume + volume} contracts for ${instrumentId}, exceeding limit of ${policy.maxPositionSize}`,
        };
      }
      return null;
    },
  });

  // ─── Max total positions across instruments ──────────────────

  rules.push({
    id: "trading.max_total_positions",
    description: `Deny orders that would exceed ${policy.maxTotalPositions} simultaneous instruments`,
    priority: 500,
    appliesTo: { by: "name", names: ["place_order"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const instrumentId = String(request.args.instrumentId ?? "");
      const { positions } = getFuturesContext(request);

      const uniqueInstruments = new Set(positions.map((p) => p.instrumentId));
      const isNewInstrument = !uniqueInstruments.has(instrumentId);

      if (isNewInstrument && uniqueInstruments.size >= policy.maxTotalPositions) {
        return {
          rule: "trading.max_total_positions",
          action: "deny",
          reasonCode: "MAX_POSITIONS_EXCEEDED",
          humanMessage: `Already holding ${uniqueInstruments.size} instruments, limit is ${policy.maxTotalPositions}`,
        };
      }
      return null;
    },
  });

  // ─── Risk ratio guard ────────────────────────────────────────

  rules.push({
    id: "trading.risk_ratio_guard",
    description: `Deny new orders when risk ratio exceeds ${policy.forceCloseAtRiskRatio}`,
    priority: 500,
    appliesTo: { by: "name", names: ["place_order"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const { riskRatio } = getFuturesContext(request);

      if (riskRatio > policy.forceCloseAtRiskRatio) {
        return {
          rule: "trading.risk_ratio_guard",
          action: "deny",
          reasonCode: "RISK_RATIO_TOO_HIGH",
          humanMessage: `Risk ratio ${(riskRatio * 100).toFixed(1)}% exceeds threshold ${(policy.forceCloseAtRiskRatio * 100).toFixed(1)}%`,
        };
      }
      return null;
    },
  });

  // ─── Max orders per turn ─────────────────────────────────────

  rules.push({
    id: "trading.max_orders_per_turn",
    description: `Deny more than ${policy.maxOrdersPerTurn} orders per turn`,
    priority: 500,
    appliesTo: { by: "name", names: ["place_order"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const count = request.turnContext.turnToolCallCount;

      if (count >= policy.maxOrdersPerTurn) {
        return {
          rule: "trading.max_orders_per_turn",
          action: "deny",
          reasonCode: "TURN_ORDER_LIMIT",
          humanMessage: `Already placed ${count} orders this turn, limit is ${policy.maxOrdersPerTurn}`,
        };
      }
      return null;
    },
  });

  // ─── Blocked instruments ─────────────────────────────────────

  if (policy.blockedInstruments.length > 0) {
    rules.push({
      id: "trading.blocked_instruments",
      description: `Deny orders for blocked instruments: ${policy.blockedInstruments.join(", ")}`,
      priority: 500,
      appliesTo: { by: "name", names: ["place_order"] },
      evaluate(request: PolicyRequest): PolicyRuleResult | null {
        const instrumentId = String(request.args.instrumentId ?? "");

        if (policy.blockedInstruments.includes(instrumentId)) {
          return {
            rule: "trading.blocked_instruments",
            action: "deny",
            reasonCode: "INSTRUMENT_BLOCKED",
            humanMessage: `Instrument ${instrumentId} is blocked by trading policy`,
          };
        }
        return null;
      },
    });
  }

  // ─── Allowed instruments (whitelist) ─────────────────────────

  if (policy.allowedInstruments.length > 0) {
    rules.push({
      id: "trading.allowed_instruments",
      description: `Only allow orders for: ${policy.allowedInstruments.join(", ")}`,
      priority: 500,
      appliesTo: { by: "name", names: ["place_order"] },
      evaluate(request: PolicyRequest): PolicyRuleResult | null {
        const instrumentId = String(request.args.instrumentId ?? "");

        if (!policy.allowedInstruments.includes(instrumentId)) {
          return {
            rule: "trading.allowed_instruments",
            action: "deny",
            reasonCode: "INSTRUMENT_NOT_ALLOWED",
            humanMessage: `Instrument ${instrumentId} is not in the allowed list`,
          };
        }
        return null;
      },
    });
  }

  // ─── Always allow close operations ───────────────────────────

  rules.push({
    id: "trading.allow_close",
    description: "Always allow closing positions (risk reduction)",
    priority: 100, // Higher priority (lower number) than deny rules
    appliesTo: { by: "name", names: ["close_position", "close_all_positions"] },
    evaluate(_request: PolicyRequest): PolicyRuleResult | null {
      // Returning null means "no opinion" — allow continues
      return null;
    },
  });

  return rules;
}
