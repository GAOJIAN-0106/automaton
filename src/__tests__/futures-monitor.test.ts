/**
 * Futures Resource Monitor Tests
 *
 * Phase 5: Tests for checkFuturesResources and formatFuturesResourceReport.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  checkFuturesResources,
  formatFuturesResourceReport,
} from "../survival/monitor.js";
import {
  MockFuturesClient,
  createTestDb,
  createTestConfig,
} from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";
import { DEFAULT_FUTURES_CONFIG } from "../futures/types.js";

function makeConfig(overrides?: Record<string, unknown>) {
  return createTestConfig({
    futuresConfig: {
      ...DEFAULT_FUTURES_CONFIG,
      gatewayUrl: "http://127.0.0.1:8400",
      initialCapital: 1_000_000,
      ...overrides,
    } as any,
  });
}

describe("checkFuturesResources", () => {
  let db: AutomatonDatabase;
  let futures: MockFuturesClient;

  beforeEach(() => {
    db = createTestDb();
    futures = new MockFuturesClient();
  });

  afterEach(() => {
    db.close();
  });

  it("returns normal tier for default 1M equity account", async () => {
    const config = makeConfig();
    const status = await checkFuturesResources(futures, config, db);

    expect(status.tier).toBe("normal");
    expect(status.gatewayConnected).toBe(true);
    expect(status.financial.effectiveEquity).toBe(1_000_000);
    expect(status.financial.equityRatio).toBe(1.0);
  });

  it("deducts inference spent from effective equity", async () => {
    db.setKV("inference_spent_cny", "200000");
    const config = makeConfig();
    const status = await checkFuturesResources(futures, config, db);

    expect(status.financial.effectiveEquity).toBe(800_000);
    expect(status.financial.equityRatio).toBe(0.8);
  });

  it("returns low_compute tier when equity ratio drops below 0.8", async () => {
    futures.account.dynamicEquity = 600_000;
    const config = makeConfig();
    const status = await checkFuturesResources(futures, config, db);

    expect(status.tier).toBe("low_compute");
  });

  it("returns critical tier when equity ratio drops below 0.5", async () => {
    futures.account.dynamicEquity = 300_000;
    const config = makeConfig();
    const status = await checkFuturesResources(futures, config, db);

    expect(status.tier).toBe("critical");
  });

  it("returns dead tier when equity ratio drops below 0.2", async () => {
    futures.account.dynamicEquity = 100_000;
    const config = makeConfig();
    const status = await checkFuturesResources(futures, config, db);

    expect(status.tier).toBe("dead");
  });

  it("returns high tier when equity ratio > 1.2", async () => {
    futures.account.dynamicEquity = 1_500_000;
    const config = makeConfig();
    const status = await checkFuturesResources(futures, config, db);

    expect(status.tier).toBe("high");
  });

  it("detects tier change", async () => {
    db.setKV("current_tier", "normal");
    futures.account.dynamicEquity = 300_000;
    const config = makeConfig();
    const status = await checkFuturesResources(futures, config, db);

    expect(status.tierChanged).toBe(true);
    expect(status.previousTier).toBe("normal");
    expect(status.tier).toBe("critical");
  });

  it("no tier change when tier stays the same", async () => {
    db.setKV("current_tier", "normal");
    const config = makeConfig();
    const status = await checkFuturesResources(futures, config, db);

    expect(status.tierChanged).toBe(false);
    expect(status.previousTier).toBe("normal");
    expect(status.tier).toBe("normal");
  });

  it("uses cached account when gateway is disconnected", async () => {
    // First call with connected gateway
    const config = makeConfig();
    await checkFuturesResources(futures, config, db);

    // Disconnect gateway
    futures.connected = false;
    futures.account.dynamicEquity = 0; // Would be dead if we could reach it

    const status = await checkFuturesResources(futures, config, db);

    // Should use cached value (1M) not the unreachable 0
    expect(status.gatewayConnected).toBe(false);
    expect(status.financial.account.dynamicEquity).toBe(1_000_000);
    expect(status.tier).toBe("normal");
  });

  it("uses initial capital as fallback when no cache exists", async () => {
    futures.connected = false;
    const config = makeConfig();
    const status = await checkFuturesResources(futures, config, db);

    expect(status.gatewayConnected).toBe(false);
    expect(status.financial.account.dynamicEquity).toBe(1_000_000);
    expect(status.tier).toBe("normal");
  });

  it("stores tier in KV after check", async () => {
    const config = makeConfig();
    await checkFuturesResources(futures, config, db);

    expect(db.getKV("current_tier")).toBe("normal");
  });

  it("caches account data for disconnection fallback", async () => {
    const config = makeConfig();
    await checkFuturesResources(futures, config, db);

    const cached = db.getKV("last_futures_account");
    expect(cached).toBeDefined();
    const parsed = JSON.parse(cached!);
    expect(parsed.dynamicEquity).toBe(1_000_000);
  });
});

describe("formatFuturesResourceReport", () => {
  it("formats complete status report", () => {
    const report = formatFuturesResourceReport({
      financial: {
        account: {
          staticEquity: 1_000_000,
          dynamicEquity: 1_050_000,
          available: 800_000,
          margin: 200_000,
          floatingPnl: 50_000,
          todayPnl: 30_000,
          riskRatio: 0.19,
          timestamp: "2024-03-01T00:00:00Z",
        },
        inferenceSpent: 5_000,
        effectiveEquity: 1_045_000,
        equityRatio: 1.045,
        initialCapital: 1_000_000,
        lastChecked: "2024-03-01T12:00:00Z",
      },
      tier: "normal",
      previousTier: null,
      tierChanged: false,
      gatewayConnected: true,
    });

    expect(report).toContain("FUTURES RESOURCE STATUS");
    expect(report).toContain("Dynamic Equity");
    expect(report).toContain("1,050,000.00");
    expect(report).toContain("Effective Equity");
    expect(report).toContain("1,045,000.00");
    expect(report).toContain("Margin Used");
    expect(report).toContain("Risk Ratio: 19.0%");
    expect(report).toContain("Tier: normal");
    expect(report).toContain("Gateway: connected");
  });

  it("shows tier change in report", () => {
    const report = formatFuturesResourceReport({
      financial: {
        account: {
          staticEquity: 1_000_000,
          dynamicEquity: 300_000,
          available: 100_000,
          margin: 200_000,
          floatingPnl: -700_000,
          todayPnl: -200_000,
          riskRatio: 0.67,
          timestamp: "2024-03-01T00:00:00Z",
        },
        inferenceSpent: 0,
        effectiveEquity: 300_000,
        equityRatio: 0.3,
        initialCapital: 1_000_000,
        lastChecked: "2024-03-01T12:00:00Z",
      },
      tier: "critical",
      previousTier: "normal",
      tierChanged: true,
      gatewayConnected: false,
    });

    expect(report).toContain("Tier: critical (changed from normal)");
    expect(report).toContain("Gateway: DISCONNECTED");
  });
});
