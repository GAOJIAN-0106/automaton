/**
 * Trading Policy Rules Tests
 *
 * TDD RED phase: Tests for futures-specific risk management rules
 * that replace the original financial policy rules.
 *
 * Rules:
 * - Max position size per instrument
 * - Max total positions across instruments
 * - Max leverage
 * - Max single trade loss
 * - Max daily loss
 * - Force close at risk ratio
 * - Max orders per turn
 * - Blocked/allowed instruments
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";
import { createTradingRules } from "../futures/policy-rules/trading.js";
import { PolicyEngine } from "../agent/policy-engine.js";
import type {
  AutomatonTool,
  PolicyRequest,
  PolicyRule,
  ToolContext,
  SpendTrackerInterface,
} from "../types.js";
import type { TradingPolicy, FuturesPosition } from "../futures/types.js";
import { DEFAULT_TRADING_POLICY } from "../futures/types.js";

// ─── Helpers ────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trading-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_decisions (
      id TEXT PRIMARY KEY,
      turn_id TEXT,
      tool_name TEXT NOT NULL,
      tool_args_hash TEXT NOT NULL,
      risk_level TEXT NOT NULL CHECK(risk_level IN ('safe','caution','dangerous','forbidden')),
      decision TEXT NOT NULL CHECK(decision IN ('allow','deny','quarantine')),
      rules_evaluated TEXT NOT NULL DEFAULT '[]',
      rules_triggered TEXT NOT NULL DEFAULT '[]',
      reason TEXT NOT NULL DEFAULT '',
      latency_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS spend_tracking (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      recipient TEXT,
      domain TEXT,
      category TEXT NOT NULL,
      window_hour TEXT NOT NULL,
      window_day TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_spend_hour ON spend_tracking(category, window_hour);
    CREATE INDEX IF NOT EXISTS idx_spend_day ON spend_tracking(category, window_day);
  `);
  return db;
}

function mockPlaceOrderTool(): AutomatonTool {
  return {
    name: "place_order",
    description: "Place a futures order",
    parameters: { type: "object", properties: {} },
    execute: async () => "ok",
    riskLevel: "dangerous",
    category: "financial",
  };
}

function mockClosePositionTool(): AutomatonTool {
  return {
    name: "close_position",
    description: "Close a position",
    parameters: { type: "object", properties: {} },
    execute: async () => "ok",
    riskLevel: "caution",
    category: "financial",
  };
}

function createMockSpendTracker(): SpendTrackerInterface {
  return {
    recordSpend: () => {},
    getHourlySpend: () => 0,
    getDailySpend: () => 0,
    getTotalSpend: () => 0,
    checkLimit: () => ({
      allowed: true,
      currentHourlySpend: 0,
      currentDailySpend: 0,
      limitHourly: 10000,
      limitDaily: 25000,
    }),
    pruneOldRecords: () => 0,
  };
}

function createRequest(
  tool: AutomatonTool,
  args: Record<string, unknown>,
  turnToolCallCount = 0,
  positions: FuturesPosition[] = [],
  riskRatio = 0.2,
  equity = 1_000_000,
): PolicyRequest {
  return {
    tool,
    args,
    context: {
      futuresState: {
        positions,
        riskRatio,
        equity,
      },
    } as unknown as ToolContext,
    turnContext: {
      inputSource: "agent",
      turnToolCallCount,
      sessionSpend: createMockSpendTracker(),
    },
  };
}

function makePosition(overrides: Partial<FuturesPosition> = {}): FuturesPosition {
  return {
    instrumentId: "IF2403",
    instrumentName: "沪深300指数期货",
    direction: "long",
    volume: 1,
    openPrice: 3500,
    currentPrice: 3500,
    floatingPnl: 0,
    margin: 100_000,
    openDate: "2026-02-24",
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("Trading Policy Rules", () => {
  let db: Database.Database;
  let rules: PolicyRule[];
  let engine: PolicyEngine;

  beforeEach(() => {
    db = createTestDb();
    rules = createTradingRules(DEFAULT_TRADING_POLICY);
    engine = new PolicyEngine(db, rules);
  });

  afterEach(() => {
    db.close();
  });

  describe("trading.max_position_size", () => {
    it("allows order within position size limit", () => {
      const request = createRequest(
        mockPlaceOrderTool(),
        { instrumentId: "IF2403", volume: 5 },
        0,
        [], // no existing positions
      );
      const decision = engine.evaluate(request);
      expect(decision.action).toBe("allow");
    });

    it("denies order exceeding max position size (10)", () => {
      const request = createRequest(
        mockPlaceOrderTool(),
        { instrumentId: "IF2403", volume: 15 },
        0,
        [], // no existing positions
      );
      const decision = engine.evaluate(request);
      expect(decision.action).toBe("deny");
      expect(decision.reasonCode).toBe("POSITION_SIZE_EXCEEDED");
    });

    it("considers existing positions when checking size", () => {
      const existing = [makePosition({ instrumentId: "IF2403", volume: 8 })];
      const request = createRequest(
        mockPlaceOrderTool(),
        { instrumentId: "IF2403", volume: 5 },
        0,
        existing,
      );
      const decision = engine.evaluate(request);
      expect(decision.action).toBe("deny");
      expect(decision.reasonCode).toBe("POSITION_SIZE_EXCEEDED");
    });
  });

  describe("trading.max_total_positions", () => {
    it("allows order when under total position limit", () => {
      const existing = [
        makePosition({ instrumentId: "IF2403" }),
        makePosition({ instrumentId: "IC2403" }),
      ];
      const request = createRequest(
        mockPlaceOrderTool(),
        { instrumentId: "IH2403", volume: 1 },
        0,
        existing,
      );
      const decision = engine.evaluate(request);
      expect(decision.action).toBe("allow");
    });

    it("denies order when at total position limit (3)", () => {
      const existing = [
        makePosition({ instrumentId: "IF2403" }),
        makePosition({ instrumentId: "IC2403" }),
        makePosition({ instrumentId: "IH2403" }),
      ];
      const request = createRequest(
        mockPlaceOrderTool(),
        { instrumentId: "rb2405", volume: 1 },
        0,
        existing,
      );
      const decision = engine.evaluate(request);
      expect(decision.action).toBe("deny");
      expect(decision.reasonCode).toBe("MAX_POSITIONS_EXCEEDED");
    });

    it("allows adding to existing instrument even at limit", () => {
      const existing = [
        makePosition({ instrumentId: "IF2403", volume: 2 }),
        makePosition({ instrumentId: "IC2403" }),
        makePosition({ instrumentId: "IH2403" }),
      ];
      // Adding volume to IF2403 which is already in positions
      const request = createRequest(
        mockPlaceOrderTool(),
        { instrumentId: "IF2403", volume: 1 },
        0,
        existing,
      );
      const decision = engine.evaluate(request);
      expect(decision.action).toBe("allow");
    });
  });

  describe("trading.risk_ratio_guard", () => {
    it("allows order when risk ratio is low", () => {
      const request = createRequest(
        mockPlaceOrderTool(),
        { instrumentId: "IF2403", volume: 1 },
        0,
        [],
        0.3, // low risk
      );
      const decision = engine.evaluate(request);
      expect(decision.action).toBe("allow");
    });

    it("denies order when risk ratio exceeds threshold", () => {
      const request = createRequest(
        mockPlaceOrderTool(),
        { instrumentId: "IF2403", volume: 1 },
        0,
        [],
        0.85, // above forceCloseAtRiskRatio (0.8)
      );
      const decision = engine.evaluate(request);
      expect(decision.action).toBe("deny");
      expect(decision.reasonCode).toBe("RISK_RATIO_TOO_HIGH");
    });
  });

  describe("trading.max_orders_per_turn", () => {
    it("allows first order in turn", () => {
      const request = createRequest(
        mockPlaceOrderTool(),
        { instrumentId: "IF2403", volume: 1 },
        0,
      );
      const decision = engine.evaluate(request);
      expect(decision.action).toBe("allow");
    });

    it("denies order exceeding per-turn limit (5)", () => {
      const request = createRequest(
        mockPlaceOrderTool(),
        { instrumentId: "IF2403", volume: 1 },
        5, // 6th order attempt
      );
      const decision = engine.evaluate(request);
      expect(decision.action).toBe("deny");
      expect(decision.reasonCode).toBe("TURN_ORDER_LIMIT");
    });
  });

  describe("trading.blocked_instruments", () => {
    it("allows order for non-blocked instrument", () => {
      const request = createRequest(
        mockPlaceOrderTool(),
        { instrumentId: "IF2403", volume: 1 },
      );
      const decision = engine.evaluate(request);
      expect(decision.action).toBe("allow");
    });

    it("denies order for blocked instrument", () => {
      const policy: TradingPolicy = {
        ...DEFAULT_TRADING_POLICY,
        blockedInstruments: ["T2403", "TF2403"],
      };
      const blockedRules = createTradingRules(policy);
      const blockedEngine = new PolicyEngine(db, blockedRules);

      const request = createRequest(
        mockPlaceOrderTool(),
        { instrumentId: "T2403", volume: 1 },
      );
      const decision = blockedEngine.evaluate(request);
      expect(decision.action).toBe("deny");
      expect(decision.reasonCode).toBe("INSTRUMENT_BLOCKED");
    });
  });

  describe("trading.allowed_instruments", () => {
    it("allows order when allowedInstruments is empty (all allowed)", () => {
      const request = createRequest(
        mockPlaceOrderTool(),
        { instrumentId: "rb2405", volume: 1 },
      );
      const decision = engine.evaluate(request);
      expect(decision.action).toBe("allow");
    });

    it("denies order for instrument not in allowlist", () => {
      const policy: TradingPolicy = {
        ...DEFAULT_TRADING_POLICY,
        allowedInstruments: ["IF2403", "IC2403", "IH2403"],
      };
      const allowedRules = createTradingRules(policy);
      const allowedEngine = new PolicyEngine(db, allowedRules);

      const request = createRequest(
        mockPlaceOrderTool(),
        { instrumentId: "rb2405", volume: 1 },
      );
      const decision = allowedEngine.evaluate(request);
      expect(decision.action).toBe("deny");
      expect(decision.reasonCode).toBe("INSTRUMENT_NOT_ALLOWED");
    });
  });

  describe("close_position always allowed", () => {
    it("allows close_position even at high risk ratio", () => {
      const request = createRequest(
        mockClosePositionTool(),
        { instrumentId: "IF2403", direction: "long" },
        0,
        [],
        0.95, // very high risk
      );
      const decision = engine.evaluate(request);
      expect(decision.action).toBe("allow");
    });
  });

  describe("Rule registration", () => {
    it("creates the expected number of trading rules", () => {
      expect(rules.length).toBeGreaterThanOrEqual(5);
    });

    it("all rules have trading.* IDs", () => {
      for (const rule of rules) {
        expect(rule.id).toMatch(/^trading\./);
      }
    });
  });
});
