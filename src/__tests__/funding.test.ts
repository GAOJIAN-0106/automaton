/**
 * Funding Strategy Tests
 *
 * Tests for executeFundingStrategies, especially per-tier cooldown isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  executeFundingStrategies,
  executeFuturesEmergencyStrategies,
} from "../survival/funding.js";
import {
  MockConwayClient,
  MockFuturesClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
} from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";
import { DEFAULT_FUTURES_CONFIG } from "../futures/types.js";

describe("executeFundingStrategies", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
    conway.creditsCents = 5; // low balance
  });

  afterEach(() => {
    db.close();
  });

  it("dead-tier cooldown does not suppress low_compute notification", async () => {
    const identity = createTestIdentity();
    const config = createTestConfig();

    // First: trigger dead-tier plea
    const deadAttempts = await executeFundingStrategies(
      "dead",
      identity,
      config,
      db,
      conway,
    );
    expect(deadAttempts.length).toBe(1);
    expect(deadAttempts[0].strategy).toBe("desperate_plea");

    // Now: agent recovers to low_compute. With the fix, the low_compute
    // notification should fire because it has its own cooldown key.
    const lowAttempts = await executeFundingStrategies(
      "low_compute",
      identity,
      config,
      db,
      conway,
    );
    expect(lowAttempts.length).toBe(1);
    expect(lowAttempts[0].strategy).toBe("polite_creator_notification");
  });

  it("critical-tier cooldown does not suppress low_compute notification", async () => {
    const identity = createTestIdentity();
    const config = createTestConfig();

    // Trigger critical-tier notice
    const criticalAttempts = await executeFundingStrategies(
      "critical",
      identity,
      config,
      db,
      conway,
    );
    expect(criticalAttempts.length).toBe(1);
    expect(criticalAttempts[0].strategy).toBe("urgent_local_notice");

    // low_compute should still fire independently
    const lowAttempts = await executeFundingStrategies(
      "low_compute",
      identity,
      config,
      db,
      conway,
    );
    expect(lowAttempts.length).toBe(1);
    expect(lowAttempts[0].strategy).toBe("polite_creator_notification");
  });

  it("respects per-tier cooldown on repeated calls", async () => {
    const identity = createTestIdentity();
    const config = createTestConfig();

    // First dead-tier call fires
    const first = await executeFundingStrategies("dead", identity, config, db, conway);
    expect(first.length).toBe(1);

    // Immediate second dead-tier call should be suppressed (2h cooldown)
    const second = await executeFundingStrategies("dead", identity, config, db, conway);
    expect(second.length).toBe(0);
  });
});

// ─── Futures Emergency Strategies ───────────────────────────────

describe("executeFuturesEmergencyStrategies", () => {
  let db: AutomatonDatabase;
  let futures: MockFuturesClient;
  let config: ReturnType<typeof createTestConfig>;

  beforeEach(() => {
    db = createTestDb();
    futures = new MockFuturesClient();
    config = createTestConfig({
      futuresConfig: {
        ...DEFAULT_FUTURES_CONFIG,
        gatewayUrl: "http://127.0.0.1:8400",
        initialCapital: 1_000_000,
      } as any,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("closes all positions on critical tier", async () => {
    const closeAllSpy = vi.spyOn(futures, "closeAllPositions");
    const attempts = await executeFuturesEmergencyStrategies(
      "critical",
      futures,
      config,
      db,
    );

    expect(closeAllSpy).toHaveBeenCalled();
    expect(attempts.length).toBe(1);
    expect(attempts[0].strategy).toBe("emergency_close_all");
    expect(attempts[0].success).toBe(true);
  });

  it("records emergency alert on critical", async () => {
    await executeFuturesEmergencyStrategies("critical", futures, config, db);

    const alert = JSON.parse(db.getKV("emergency_alert")!);
    expect(alert.tier).toBe("critical");
    expect(alert.action).toBe("close_all_positions");
  });

  it("halts trading on dead tier", async () => {
    const attempts = await executeFuturesEmergencyStrategies(
      "dead",
      futures,
      config,
      db,
    );

    expect(attempts.some((a) => a.strategy === "halt_trading")).toBe(true);
    const alert = JSON.parse(db.getKV("emergency_alert")!);
    expect(alert.tier).toBe("dead");
    expect(alert.action).toBe("halt_trading");
  });

  it("force-closes remaining positions on dead tier", async () => {
    futures.positions = [
      {
        instrumentId: "IF2403",
        instrumentName: "IF2403",
        direction: "long",
        volume: 1,
        openPrice: 5000,
        currentPrice: 4500,
        floatingPnl: -50000,
        margin: 100000,
        openDate: "2024-03-01",
      },
    ];

    const closeAllSpy = vi.spyOn(futures, "closeAllPositions");
    await executeFuturesEmergencyStrategies("dead", futures, config, db);

    expect(closeAllSpy).toHaveBeenCalled();
  });

  it("respects cooldown on repeated calls", async () => {
    const first = await executeFuturesEmergencyStrategies(
      "critical",
      futures,
      config,
      db,
    );
    expect(first.length).toBe(1);

    // Immediate second call should be suppressed (5min cooldown)
    const second = await executeFuturesEmergencyStrategies(
      "critical",
      futures,
      config,
      db,
    );
    expect(second.length).toBe(0);
  });

  it("does nothing for normal/high/low_compute tiers", async () => {
    for (const tier of ["normal", "high", "low_compute"] as const) {
      const attempts = await executeFuturesEmergencyStrategies(
        tier,
        futures,
        config,
        db,
      );
      expect(attempts.length).toBe(0);
    }
  });

  it("handles gateway failure on critical tier", async () => {
    futures.closeAllPositions = async () => {
      throw new Error("connection refused");
    };

    const attempts = await executeFuturesEmergencyStrategies(
      "critical",
      futures,
      config,
      db,
    );

    expect(attempts.length).toBe(1);
    expect(attempts[0].success).toBe(false);
    expect(attempts[0].details).toContain("connection refused");
  });
});
