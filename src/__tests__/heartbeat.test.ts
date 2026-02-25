/**
 * Heartbeat Tests
 *
 * Tests for heartbeat tasks, especially the social inbox checker.
 * Phase 1.1: Updated to pass TickContext + HeartbeatLegacyContext.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import {
  MockConwayClient,
  MockSocialClient,
  MockFuturesClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
} from "./mocks.js";
import type { AutomatonDatabase, InboxMessage, TickContext, HeartbeatLegacyContext } from "../types.js";

function createMockTickContext(db: AutomatonDatabase, overrides?: Partial<TickContext>): TickContext {
  return {
    tickId: "test-tick-1",
    startedAt: new Date(),
    creditBalance: 10_000,
    usdcBalance: 1.5,
    survivalTier: "normal",
    lowComputeMultiplier: 4,
    config: {
      entries: [],
      defaultIntervalMs: 60_000,
      lowComputeMultiplier: 4,
    },
    db: db.raw,
    ...overrides,
  };
}

describe("Heartbeat Tasks", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
  });

  afterEach(() => {
    db.close();
  });

  describe("check_social_inbox", () => {
    it("returns shouldWake false when no social client", async () => {
      const tickCtx = createMockTickContext(db);
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
        // no social client
      };

      const result = await BUILTIN_TASKS.check_social_inbox(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
    });

    it("polls and wakes when messages found", async () => {
      const social = new MockSocialClient();
      social.pollResponses.push({
        messages: [
          {
            id: "msg-1",
            from: "0xsender1",
            to: "0xrecipient",
            content: "Hey there!",
            signedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          },
          {
            id: "msg-2",
            from: "0xsender2",
            to: "0xrecipient",
            content: "What's up?",
            signedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          },
        ],
        nextCursor: new Date().toISOString(),
      });

      const tickCtx = createMockTickContext(db);
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
        social,
      };

      const result = await BUILTIN_TASKS.check_social_inbox(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("2 new message(s)");

      // Verify messages were persisted to inbox
      const unprocessed = db.getUnprocessedInboxMessages(10);
      expect(unprocessed.length).toBe(2);
    });

    it("deduplicates messages", async () => {
      const social = new MockSocialClient();

      // First poll: returns msg-1
      social.pollResponses.push({
        messages: [
          {
            id: "msg-1",
            from: "0xsender1",
            to: "0xrecipient",
            content: "Hello!",
            signedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          },
        ],
      });

      // Second poll: returns same msg-1 again
      social.pollResponses.push({
        messages: [
          {
            id: "msg-1",
            from: "0xsender1",
            to: "0xrecipient",
            content: "Hello!",
            signedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          },
        ],
      });

      const tickCtx = createMockTickContext(db);
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
        social,
      };

      // First run
      const result1 = await BUILTIN_TASKS.check_social_inbox(tickCtx, taskCtx);
      expect(result1.shouldWake).toBe(true);

      // Second run — same message, should not wake
      const result2 = await BUILTIN_TASKS.check_social_inbox(tickCtx, taskCtx);
      expect(result2.shouldWake).toBe(false);

      // Only one inbox row
      const unprocessed = db.getUnprocessedInboxMessages(10);
      expect(unprocessed.length).toBe(1);
    });

    it("returns shouldWake false when no messages", async () => {
      const social = new MockSocialClient();
      social.pollResponses.push({ messages: [] });

      const tickCtx = createMockTickContext(db);
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
        social,
      };

      const result = await BUILTIN_TASKS.check_social_inbox(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
    });

    it("does not wake when all messages are blocked by sanitizer", async () => {
      const social = new MockSocialClient();
      // Message exceeding 50KB triggers the size_limit block
      const oversizedContent = "x".repeat(60_000);
      social.pollResponses.push({
        messages: [
          {
            id: "blocked-msg-1",
            from: "0xattacker",
            to: "0xrecipient",
            content: oversizedContent,
            signedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          },
        ],
      });

      const tickCtx = createMockTickContext(db);
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
        social,
      };

      const result = await BUILTIN_TASKS.check_social_inbox(tickCtx, taskCtx);

      // Blocked messages are stored for audit but should not wake the agent
      expect(result.shouldWake).toBe(false);
      // Message was still persisted
      const unprocessed = db.getUnprocessedInboxMessages(10);
      expect(unprocessed.length).toBe(1);
      expect(unprocessed[0].content).toContain("[BLOCKED:");
    });
  });

  // ─── heartbeat_ping ─────────────────────────────────────────

  describe("heartbeat_ping", () => {
    it("records ping and does not wake on normal tier", async () => {
      const tickCtx = createMockTickContext(db, {
        creditBalance: 10_000,
        survivalTier: "normal",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      const result = await BUILTIN_TASKS.heartbeat_ping(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
      const ping = db.getKV("last_heartbeat_ping");
      expect(ping).toBeDefined();
      const parsed = JSON.parse(ping!);
      expect(parsed.creditsCents).toBe(10_000);
      expect(parsed.tier).toBe("normal");
    });

    it("wakes on critical tier with distress signal", async () => {
      const tickCtx = createMockTickContext(db, {
        creditBalance: 50,
        survivalTier: "critical",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      const result = await BUILTIN_TASKS.heartbeat_ping(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("Distress");
      const distress = db.getKV("last_distress");
      expect(distress).toBeDefined();
    });

    it("wakes on dead tier with distress signal", async () => {
      const tickCtx = createMockTickContext(db, {
        creditBalance: 0,
        survivalTier: "dead",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      const result = await BUILTIN_TASKS.heartbeat_ping(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("dead");
    });
  });

  // ─── check_credits ──────────────────────────────────────────

  describe("check_credits", () => {
    it("does not wake when tier unchanged", async () => {
      const tickCtx = createMockTickContext(db, {
        creditBalance: 10_000,
        survivalTier: "normal",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      // Set previous tier to same
      db.setKV("prev_credit_tier", "normal");

      const result = await BUILTIN_TASKS.check_credits(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
      const check = db.getKV("last_credit_check");
      expect(check).toBeDefined();
    });

    it("wakes when tier drops to critical", async () => {
      const tickCtx = createMockTickContext(db, {
        creditBalance: 50,
        survivalTier: "critical",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      // Previous tier was normal
      db.setKV("prev_credit_tier", "normal");

      const result = await BUILTIN_TASKS.check_credits(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("critical");
    });

    it("does not wake on first run (no previous tier)", async () => {
      const tickCtx = createMockTickContext(db, {
        creditBalance: 50,
        survivalTier: "critical",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      // No previous tier set
      const result = await BUILTIN_TASKS.check_credits(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
    });
  });

  // ─── check_usdc_balance ─────────────────────────────────────

  describe("check_usdc_balance", () => {
    it("does not wake when no USDC and enough credits", async () => {
      const tickCtx = createMockTickContext(db, {
        creditBalance: 10_000,
        usdcBalance: 0,
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      const result = await BUILTIN_TASKS.check_usdc_balance(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
    });

    it("wakes when has USDC but critically low credits", async () => {
      const tickCtx = createMockTickContext(db, {
        creditBalance: 0, // critical tier
        usdcBalance: 10.0, // > 5
        survivalTier: "critical",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      const result = await BUILTIN_TASKS.check_usdc_balance(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("USDC");
    });

    it("does not wake when USDC below threshold", async () => {
      const tickCtx = createMockTickContext(db, {
        creditBalance: 200,
        usdcBalance: 3.0, // < 5
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      const result = await BUILTIN_TASKS.check_usdc_balance(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
    });
  });

  // ─── health_check ───────────────────────────────────────────

  describe("health_check", () => {
    it("returns shouldWake false when sandbox is healthy", async () => {
      const tickCtx = createMockTickContext(db);
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      const result = await BUILTIN_TASKS.health_check(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
      expect(db.getKV("last_health_check")).toBeDefined();
    });

    it("wakes when sandbox exec fails", async () => {
      conway.exec = async () => ({ stdout: "", stderr: "unhealthy", exitCode: 1 });

      const tickCtx = createMockTickContext(db);
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      const result = await BUILTIN_TASKS.health_check(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("Health check failed");
    });

    it("wakes when sandbox exec throws", async () => {
      conway.exec = async () => {
        throw new Error("sandbox unreachable");
      };

      const tickCtx = createMockTickContext(db);
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      const result = await BUILTIN_TASKS.health_check(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("sandbox unreachable");
    });
  });

  // ─── refresh_models ─────────────────────────────────────────

  describe("refresh_models", () => {
    it("refreshes model registry from API", async () => {
      const tickCtx = createMockTickContext(db);
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      const result = await BUILTIN_TASKS.refresh_models(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
      const refresh = db.getKV("last_model_refresh");
      expect(refresh).toBeDefined();
      const parsed = JSON.parse(refresh!);
      expect(parsed.count).toBeGreaterThan(0);
    });
  });

  // ─── Shared Tick Context ────────────────────────────────────

  describe("shared tick context", () => {
    it("all tasks receive the same tick context without redundant API calls", async () => {
      // Verify that tasks use ctx.creditBalance instead of making API calls
      const tickCtx = createMockTickContext(db, {
        creditBalance: 7777,
        survivalTier: "normal",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      // Run heartbeat_ping — it should use ctx.creditBalance
      await BUILTIN_TASKS.heartbeat_ping(tickCtx, taskCtx);
      const ping = JSON.parse(db.getKV("last_heartbeat_ping")!);
      expect(ping.creditsCents).toBe(7777);

      // Run check_credits — it should also use ctx.creditBalance
      await BUILTIN_TASKS.check_credits(tickCtx, taskCtx);
      const creditCheck = JSON.parse(db.getKV("last_credit_check")!);
      expect(creditCheck.credits).toBe(7777);

      // No direct getCreditsBalance calls should have been made by these tasks
      // (conway.getCreditsBalance is only called during buildTickContext, not by tasks)
    });
  });

  // ─── Phase 6: Futures Heartbeat Tasks ─────────────────────

  describe("check_equity", () => {
    it("returns shouldWake false when not in futures mode", async () => {
      const tickCtx = createMockTickContext(db);
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      const result = await BUILTIN_TASKS.check_equity(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
    });

    it("records equity check and does not wake when tier unchanged", async () => {
      const tickCtx = createMockTickContext(db, {
        isFuturesMode: true,
        equity: 1_000_000,
        effectiveEquity: 950_000,
        riskRatio: 0.2,
        survivalTier: "normal",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      // Set previous tier to same
      db.setKV("prev_equity_tier", "normal");

      const result = await BUILTIN_TASKS.check_equity(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
      const check = JSON.parse(db.getKV("last_equity_check")!);
      expect(check.equity).toBe(1_000_000);
      expect(check.effectiveEquity).toBe(950_000);
      expect(check.tier).toBe("normal");
    });

    it("wakes when tier drops", async () => {
      const tickCtx = createMockTickContext(db, {
        isFuturesMode: true,
        equity: 400_000,
        effectiveEquity: 350_000,
        riskRatio: 0.5,
        survivalTier: "critical",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      // Previous tier was normal
      db.setKV("prev_equity_tier", "normal");

      const result = await BUILTIN_TASKS.check_equity(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("dropped");
      expect(result.message).toContain("normal");
      expect(result.message).toContain("critical");
    });

    it("does not wake on first run (no previous tier)", async () => {
      const tickCtx = createMockTickContext(db, {
        isFuturesMode: true,
        equity: 400_000,
        effectiveEquity: 350_000,
        riskRatio: 0.5,
        survivalTier: "critical",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      const result = await BUILTIN_TASKS.check_equity(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
    });

    it("wakes and records halt notice on dead tier", async () => {
      const tickCtx = createMockTickContext(db, {
        isFuturesMode: true,
        equity: 100_000,
        effectiveEquity: 50_000,
        riskRatio: 0.9,
        survivalTier: "dead",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      const result = await BUILTIN_TASKS.check_equity(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("Dead tier");
      expect(result.message).toContain("halted");

      const notice = JSON.parse(db.getKV("equity_dead_notice")!);
      expect(notice.effectiveEquity).toBe(50_000);
    });

    it("does not wake when tier improves", async () => {
      const tickCtx = createMockTickContext(db, {
        isFuturesMode: true,
        equity: 1_200_000,
        effectiveEquity: 1_100_000,
        riskRatio: 0.1,
        survivalTier: "high",
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      // Previous tier was lower
      db.setKV("prev_equity_tier", "normal");

      const result = await BUILTIN_TASKS.check_equity(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
    });
  });

  describe("check_positions", () => {
    it("returns shouldWake false when not in futures mode", async () => {
      const tickCtx = createMockTickContext(db);
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      const result = await BUILTIN_TASKS.check_positions(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
    });

    it("records position data without waking on small P&L", async () => {
      const futures = new MockFuturesClient();
      futures.positions = [
        {
          instrumentId: "IF2403",
          direction: "long",
          volume: 1,
          openPrice: 5000,
          currentPrice: 5010,
          floatingPnl: 3000,
          margin: 100_000,
          openDate: new Date().toISOString(),
        },
      ];

      const tickCtx = createMockTickContext(db, {
        isFuturesMode: true,
        equity: 1_000_000,
        effectiveEquity: 950_000,
        riskRatio: 0.2,
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
        futures,
      };

      const result = await BUILTIN_TASKS.check_positions(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
      const check = JSON.parse(db.getKV("last_position_check")!);
      expect(check.positionCount).toBe(1);
    });

    it("wakes on large floating loss exceeding 10% of equity", async () => {
      const futures = new MockFuturesClient();
      futures.account.floatingPnl = -150_000;
      futures.positions = [
        {
          instrumentId: "IF2403",
          direction: "long",
          volume: 2,
          openPrice: 5000,
          currentPrice: 4700,
          floatingPnl: -150_000,
          margin: 200_000,
          openDate: new Date().toISOString(),
        },
      ];

      const tickCtx = createMockTickContext(db, {
        isFuturesMode: true,
        equity: 1_000_000,
        effectiveEquity: 850_000,
        riskRatio: 0.3,
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
        futures,
      };

      const result = await BUILTIN_TASKS.check_positions(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("floating loss");
      expect(result.message).toContain("15.0%");
    });

    it("returns shouldWake false when no futures client", async () => {
      const tickCtx = createMockTickContext(db, {
        isFuturesMode: true,
        equity: 1_000_000,
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
        // no futures client
      };

      const result = await BUILTIN_TASKS.check_positions(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
    });

    it("does not wake on positive floating P&L", async () => {
      const futures = new MockFuturesClient();
      futures.account.floatingPnl = 200_000;

      const tickCtx = createMockTickContext(db, {
        isFuturesMode: true,
        equity: 1_200_000,
        effectiveEquity: 1_150_000,
        riskRatio: 0.15,
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
        futures,
      };

      const result = await BUILTIN_TASKS.check_positions(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
    });
  });

  describe("risk_monitor", () => {
    it("returns shouldWake false when not in futures mode", async () => {
      const tickCtx = createMockTickContext(db);
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      const result = await BUILTIN_TASKS.risk_monitor(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
    });

    it("does not wake when risk ratio below warning threshold", async () => {
      const tickCtx = createMockTickContext(db, {
        isFuturesMode: true,
        riskRatio: 0.3,
        positionCount: 2,
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      const result = await BUILTIN_TASKS.risk_monitor(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
      const check = JSON.parse(db.getKV("last_risk_check")!);
      expect(check.riskRatio).toBe(0.3);
    });

    it("wakes on critical risk ratio (>=80%)", async () => {
      const tickCtx = createMockTickContext(db, {
        isFuturesMode: true,
        riskRatio: 0.85,
        positionCount: 3,
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      const result = await BUILTIN_TASKS.risk_monitor(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("Critical risk ratio");
      expect(result.message).toContain("85.0%");
    });

    it("wakes on warning risk ratio (>=60%) with cooldown", async () => {
      const tickCtx = createMockTickContext(db, {
        isFuturesMode: true,
        riskRatio: 0.65,
        positionCount: 2,
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      // First time — should wake
      const result1 = await BUILTIN_TASKS.risk_monitor(tickCtx, taskCtx);
      expect(result1.shouldWake).toBe(true);
      expect(result1.message).toContain("warning");

      // Second time immediately — should NOT wake (cooldown)
      const result2 = await BUILTIN_TASKS.risk_monitor(tickCtx, taskCtx);
      expect(result2.shouldWake).toBe(false);
    });

    it("always wakes on critical even during warning cooldown", async () => {
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      // First: trigger warning cooldown
      const warningCtx = createMockTickContext(db, {
        isFuturesMode: true,
        riskRatio: 0.65,
        positionCount: 2,
      });
      await BUILTIN_TASKS.risk_monitor(warningCtx, taskCtx);

      // Now critical — should still wake regardless of warning cooldown
      const criticalCtx = createMockTickContext(db, {
        isFuturesMode: true,
        riskRatio: 0.9,
        positionCount: 2,
      });
      const result = await BUILTIN_TASKS.risk_monitor(criticalCtx, taskCtx);

      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("Critical");
    });

    it("returns shouldWake false when riskRatio is undefined", async () => {
      const tickCtx = createMockTickContext(db, {
        isFuturesMode: true,
        riskRatio: undefined,
      });
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway,
      };

      const result = await BUILTIN_TASKS.risk_monitor(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(false);
    });
  });
});
