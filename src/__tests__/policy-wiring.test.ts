/**
 * Policy Engine Wiring Tests (Phase 7)
 *
 * Verifies that:
 * - createFuturesDefaultRules produces trading rules, not financial rules
 * - PolicyEngine with trading rules enforces position/risk limits
 * - futuresState context is correctly consumed by trading rules
 * - turnToolCallCount counts place_order in futures mode
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";
import {
  createDefaultRules,
  createFuturesDefaultRules,
} from "../agent/policy-rules/index.js";
import { PolicyEngine } from "../agent/policy-engine.js";
import type {
  AutomatonTool,
  PolicyRequest,
  ToolContext,
  SpendTrackerInterface,
} from "../types.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";
import type { FuturesPosition } from "../futures/types.js";
import { DEFAULT_TRADING_POLICY } from "../futures/types.js";

// ─── Helpers ────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-wiring-"));
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
  `);
  return db;
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

function mockTool(name: string, riskLevel = "dangerous" as const, category = "trading" as const): AutomatonTool {
  return {
    name,
    description: `Mock ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => "ok",
    riskLevel,
    category,
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

function createFuturesRequest(
  tool: AutomatonTool,
  args: Record<string, unknown>,
  opts: {
    turnToolCallCount?: number;
    positions?: FuturesPosition[];
    riskRatio?: number;
    equity?: number;
  } = {},
): PolicyRequest {
  return {
    tool,
    args,
    context: {
      futuresState: {
        positions: opts.positions ?? [],
        riskRatio: opts.riskRatio ?? 0.2,
        equity: opts.equity ?? 1_000_000,
      },
    } as unknown as ToolContext,
    turnContext: {
      inputSource: "agent",
      turnToolCallCount: opts.turnToolCallCount ?? 0,
      sessionSpend: createMockSpendTracker(),
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("createFuturesDefaultRules vs createDefaultRules", () => {
  it("createDefaultRules contains financial.* rules", () => {
    const rules = createDefaultRules();
    const financialRules = rules.filter((r) => r.id.startsWith("financial."));
    const tradingRules = rules.filter((r) => r.id.startsWith("trading."));

    expect(financialRules.length).toBeGreaterThan(0);
    expect(tradingRules.length).toBe(0);
  });

  it("createFuturesDefaultRules contains trading.* rules, no financial.* rules", () => {
    const rules = createFuturesDefaultRules();
    const financialRules = rules.filter((r) => r.id.startsWith("financial."));
    const tradingRules = rules.filter((r) => r.id.startsWith("trading."));

    expect(financialRules.length).toBe(0);
    expect(tradingRules.length).toBeGreaterThan(0);
  });

  it("both share non-financial/non-trading rules", () => {
    const legacyRules = createDefaultRules();
    const futuresRules = createFuturesDefaultRules();

    const legacyShared = legacyRules.filter(
      (r) => !r.id.startsWith("financial.") && !r.id.startsWith("trading."),
    );
    const futuresShared = futuresRules.filter(
      (r) => !r.id.startsWith("financial.") && !r.id.startsWith("trading."),
    );

    // Should have the same shared rules (validation, command-safety, etc.)
    expect(legacyShared.map((r) => r.id).sort()).toEqual(
      futuresShared.map((r) => r.id).sort(),
    );
  });

  it("createFuturesDefaultRules accepts custom TradingPolicy", () => {
    const rules = createFuturesDefaultRules({
      ...DEFAULT_TRADING_POLICY,
      blockedInstruments: ["T2403"],
    });
    const blockedRule = rules.find((r) => r.id === "trading.blocked_instruments");
    expect(blockedRule).toBeDefined();
  });
});

describe("PolicyEngine with futures rules", () => {
  let db: Database.Database;
  let engine: PolicyEngine;

  beforeEach(() => {
    db = createTestDb();
    const rules = createFuturesDefaultRules();
    engine = new PolicyEngine(db, rules);
  });

  afterEach(() => {
    db.close();
  });

  it("allows place_order within limits", () => {
    const request = createFuturesRequest(
      mockTool("place_order"),
      { instrumentId: "IF2403", volume: 3 },
    );
    const decision = engine.evaluate(request);
    expect(decision.action).toBe("allow");
  });

  it("denies place_order exceeding position size", () => {
    const request = createFuturesRequest(
      mockTool("place_order"),
      { instrumentId: "IF2403", volume: 15 },
    );
    const decision = engine.evaluate(request);
    expect(decision.action).toBe("deny");
    expect(decision.reasonCode).toBe("POSITION_SIZE_EXCEEDED");
  });

  it("denies place_order when risk ratio exceeds threshold", () => {
    const request = createFuturesRequest(
      mockTool("place_order"),
      { instrumentId: "IF2403", volume: 1 },
      { riskRatio: 0.85 },
    );
    const decision = engine.evaluate(request);
    expect(decision.action).toBe("deny");
    expect(decision.reasonCode).toBe("RISK_RATIO_TOO_HIGH");
  });

  it("denies place_order exceeding max orders per turn", () => {
    const request = createFuturesRequest(
      mockTool("place_order"),
      { instrumentId: "IF2403", volume: 1 },
      { turnToolCallCount: 5 },
    );
    const decision = engine.evaluate(request);
    expect(decision.action).toBe("deny");
    expect(decision.reasonCode).toBe("TURN_ORDER_LIMIT");
  });

  it("allows close_position regardless of risk ratio", () => {
    const request = createFuturesRequest(
      mockTool("close_position", "caution", "trading"),
      { instrumentId: "IF2403", direction: "long" },
      { riskRatio: 0.95 },
    );
    const decision = engine.evaluate(request);
    expect(decision.action).toBe("allow");
  });

  it("allows safe tools (non-trading) without futures context", () => {
    const request: PolicyRequest = {
      tool: mockTool("system_synopsis", "safe", "vm" as any),
      args: {},
      context: {} as ToolContext,
      turnContext: {
        inputSource: "creator",
        turnToolCallCount: 0,
        sessionSpend: createMockSpendTracker(),
      },
    };
    const decision = engine.evaluate(request);
    expect(decision.action).toBe("allow");
  });

  it("considers existing positions for total position limit", () => {
    const positions = [
      makePosition({ instrumentId: "IF2403" }),
      makePosition({ instrumentId: "IC2403" }),
      makePosition({ instrumentId: "IH2403" }),
    ];
    const request = createFuturesRequest(
      mockTool("place_order"),
      { instrumentId: "rb2405", volume: 1 },
      { positions },
    );
    const decision = engine.evaluate(request);
    expect(decision.action).toBe("deny");
    expect(decision.reasonCode).toBe("MAX_POSITIONS_EXCEEDED");
  });

  it("allows adding volume to existing instrument at position limit", () => {
    const positions = [
      makePosition({ instrumentId: "IF2403", volume: 2 }),
      makePosition({ instrumentId: "IC2403" }),
      makePosition({ instrumentId: "IH2403" }),
    ];
    const request = createFuturesRequest(
      mockTool("place_order"),
      { instrumentId: "IF2403", volume: 1 },
      { positions },
    );
    const decision = engine.evaluate(request);
    expect(decision.action).toBe("allow");
  });
});

describe("futures mode does not include legacy financial rules", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("legacy transfer_credits is not governed by futures rules", () => {
    const rules = createFuturesDefaultRules();
    const engine = new PolicyEngine(db, rules);

    // transfer_credits doesn't exist in futures mode tools,
    // but if it somehow ran, no financial rules would catch it
    const request: PolicyRequest = {
      tool: mockTool("transfer_credits", "dangerous", "financial" as any),
      args: { amount_cents: 999999 },
      context: {} as ToolContext,
      turnContext: {
        inputSource: "agent",
        turnToolCallCount: 0,
        sessionSpend: createMockSpendTracker(),
      },
    };
    const decision = engine.evaluate(request);
    // No financial rules to deny it — should be allowed
    expect(decision.action).toBe("allow");
  });
});
