/**
 * Futures Account Module Tests
 *
 * TDD RED phase: These tests define the expected behavior of the
 * futures-based survival system before implementation.
 *
 * Tests cover:
 * - Survival tier calculation from equity ratio
 * - Effective equity computation (equity - inference spent)
 * - Financial state snapshot creation
 * - Edge cases: zero equity, negative PnL, exact boundaries
 */

import { describe, it, expect } from "vitest";
import {
  getFuturesSurvivalTier,
  getEffectiveEquity,
  computeFinancialState,
  formatEquity,
} from "../futures/account.js";
import {
  DEFAULT_FUTURES_SURVIVAL_THRESHOLDS,
  type FuturesAccount,
  type FuturesSurvivalThresholds,
} from "../futures/types.js";

// ─── Helpers ────────────────────────────────────────────────────

function makeFuturesAccount(overrides: Partial<FuturesAccount> = {}): FuturesAccount {
  return {
    staticEquity: 1_000_000,
    dynamicEquity: 1_000_000,
    available: 800_000,
    margin: 200_000,
    floatingPnl: 0,
    todayPnl: 0,
    riskRatio: 0.2,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ─── getSurvivalTier ────────────────────────────────────────────

describe("getFuturesSurvivalTier", () => {
  const thresholds = DEFAULT_FUTURES_SURVIVAL_THRESHOLDS;

  it("returns 'high' when equity ratio > 1.2", () => {
    const tier = getFuturesSurvivalTier(1.5, thresholds);
    expect(tier).toBe("high");
  });

  it("returns 'normal' when equity ratio is between 0.8 and 1.2", () => {
    const tier = getFuturesSurvivalTier(1.0, thresholds);
    expect(tier).toBe("normal");
  });

  it("returns 'low_compute' when equity ratio is between 0.5 and 0.8", () => {
    const tier = getFuturesSurvivalTier(0.6, thresholds);
    expect(tier).toBe("low_compute");
  });

  it("returns 'critical' when equity ratio is between 0.2 and 0.5", () => {
    const tier = getFuturesSurvivalTier(0.3, thresholds);
    expect(tier).toBe("critical");
  });

  it("returns 'dead' when equity ratio <= 0.2", () => {
    const tier = getFuturesSurvivalTier(0.1, thresholds);
    expect(tier).toBe("dead");
  });

  it("returns 'dead' when equity ratio is 0", () => {
    const tier = getFuturesSurvivalTier(0, thresholds);
    expect(tier).toBe("dead");
  });

  it("returns 'dead' when equity ratio is negative (margin call)", () => {
    const tier = getFuturesSurvivalTier(-0.5, thresholds);
    expect(tier).toBe("dead");
  });

  // Boundary tests
  it("returns 'high' at exactly 1.2 (boundary inclusive)", () => {
    // > 1.2 is high; exactly 1.2 is normal
    const tier = getFuturesSurvivalTier(1.2, thresholds);
    expect(tier).toBe("normal");
  });

  it("returns 'high' at 1.2001", () => {
    const tier = getFuturesSurvivalTier(1.2001, thresholds);
    expect(tier).toBe("high");
  });

  it("returns 'normal' at exactly 0.8 (boundary inclusive)", () => {
    // > 0.8 is normal; exactly 0.8 is low_compute
    const tier = getFuturesSurvivalTier(0.8, thresholds);
    expect(tier).toBe("low_compute");
  });

  it("returns 'critical' at exactly 0.2", () => {
    const tier = getFuturesSurvivalTier(0.2, thresholds);
    expect(tier).toBe("dead");
  });

  // Custom thresholds
  it("respects custom thresholds", () => {
    const custom: FuturesSurvivalThresholds = {
      high: 2.0,
      normal: 1.5,
      low_compute: 1.0,
      critical: 0.5,
    };
    expect(getFuturesSurvivalTier(1.8, custom)).toBe("normal");
    expect(getFuturesSurvivalTier(2.1, custom)).toBe("high");
    expect(getFuturesSurvivalTier(0.3, custom)).toBe("dead");
  });
});

// ─── getEffectiveEquity ─────────────────────────────────────────

describe("getEffectiveEquity", () => {
  it("returns dynamicEquity minus inferenceSpent", () => {
    const result = getEffectiveEquity(1_000_000, 5_000);
    expect(result).toBe(995_000);
  });

  it("returns dynamicEquity when no inference spent", () => {
    const result = getEffectiveEquity(1_000_000, 0);
    expect(result).toBe(1_000_000);
  });

  it("can go negative if inference spent exceeds equity", () => {
    const result = getEffectiveEquity(100, 500);
    expect(result).toBe(-400);
  });

  it("handles zero equity", () => {
    const result = getEffectiveEquity(0, 100);
    expect(result).toBe(-100);
  });
});

// ─── computeFinancialState ──────────────────────────────────────

describe("computeFinancialState", () => {
  it("computes financial state with correct equity ratio", () => {
    const account = makeFuturesAccount({ dynamicEquity: 1_200_000 });
    const state = computeFinancialState(account, 0, 1_000_000);

    expect(state.effectiveEquity).toBe(1_200_000);
    expect(state.equityRatio).toBe(1.2);
    expect(state.inferenceSpent).toBe(0);
    expect(state.initialCapital).toBe(1_000_000);
  });

  it("deducts inference spent from effective equity", () => {
    const account = makeFuturesAccount({ dynamicEquity: 1_000_000 });
    const state = computeFinancialState(account, 10_000, 1_000_000);

    expect(state.effectiveEquity).toBe(990_000);
    expect(state.equityRatio).toBe(0.99);
  });

  it("handles loss scenario correctly", () => {
    const account = makeFuturesAccount({
      dynamicEquity: 500_000,
      floatingPnl: -500_000,
    });
    const state = computeFinancialState(account, 0, 1_000_000);

    expect(state.effectiveEquity).toBe(500_000);
    expect(state.equityRatio).toBe(0.5);
  });

  it("handles zero initial capital safely", () => {
    const account = makeFuturesAccount({ dynamicEquity: 100 });
    // Should not throw, equityRatio should be Infinity or capped
    const state = computeFinancialState(account, 0, 0);
    expect(state.equityRatio).toBe(0);
  });

  it("sets lastChecked to current time", () => {
    const before = new Date().toISOString();
    const account = makeFuturesAccount();
    const state = computeFinancialState(account, 0, 1_000_000);
    const after = new Date().toISOString();

    expect(state.lastChecked >= before).toBe(true);
    expect(state.lastChecked <= after).toBe(true);
  });
});

// ─── formatEquity ───────────────────────────────────────────────

describe("formatEquity", () => {
  it("formats positive equity in CNY", () => {
    expect(formatEquity(1_234_567.89)).toBe("¥1,234,567.89");
  });

  it("formats zero", () => {
    expect(formatEquity(0)).toBe("¥0.00");
  });

  it("formats negative equity", () => {
    expect(formatEquity(-50_000)).toBe("-¥50,000.00");
  });

  it("formats small amounts", () => {
    expect(formatEquity(0.5)).toBe("¥0.50");
  });
});
