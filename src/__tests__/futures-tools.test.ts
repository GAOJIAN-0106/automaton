/**
 * Futures Trading Tools Tests
 *
 * Phase 3: Tests for 8 new trading tools + modified fund_child.
 * Validates tool execution, futures-not-enabled guard, and correct
 * formatting of results.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createBuiltinTools, executeTool } from "../agent/tools.js";
import type { AutomatonTool, ToolContext } from "../types.js";
import {
  MockConwayClient,
  MockInferenceClient,
  MockFuturesClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
} from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";
import type { FuturesPosition } from "../futures/types.js";
import { DEFAULT_FUTURES_CONFIG } from "../futures/types.js";

// ─── Helpers ────────────────────────────────────────────────────

function findTool(tools: AutomatonTool[], name: string): AutomatonTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool;
}

function createToolContext(overrides?: {
  futures?: MockFuturesClient | null;
  db?: AutomatonDatabase;
}): ToolContext {
  const db = overrides?.db ?? createTestDb();
  return {
    identity: createTestIdentity(),
    config: createTestConfig({
      futuresConfig: {
        ...DEFAULT_FUTURES_CONFIG,
        gatewayUrl: "http://127.0.0.1:8400",
        initialCapital: 1_000_000,
      } as any,
    }),
    db,
    conway: new MockConwayClient(),
    inference: new MockInferenceClient(),
    futures: overrides?.futures === null ? undefined : (overrides?.futures ?? new MockFuturesClient()),
  };
}

// ─── Deleted tools should NOT exist ────────────────────────────

describe("deleted tools", () => {
  const tools = createBuiltinTools("test-sandbox");

  it.each([
    "check_credits",
    "check_usdc_balance",
    "topup_credits",
    "transfer_credits",
    "x402_fetch",
  ])("tool '%s' should not exist", (name) => {
    const tool = tools.find((t) => t.name === name);
    expect(tool).toBeUndefined();
  });
});

// ─── New trading tools should exist ────────────────────────────

describe("new trading tools exist", () => {
  const tools = createBuiltinTools("test-sandbox");

  it.each([
    "check_equity",
    "check_positions",
    "get_market_snapshot",
    "get_pnl_report",
    "place_order",
    "cancel_order",
    "close_position",
    "close_all_positions",
  ])("tool '%s' should exist with category 'trading'", (name) => {
    const tool = findTool(tools, name);
    expect(tool.category).toBe("trading");
  });

  it("query tools are safe", () => {
    const safeTools = ["check_equity", "check_positions", "get_market_snapshot", "get_pnl_report"];
    for (const name of safeTools) {
      expect(findTool(tools, name).riskLevel).toBe("safe");
    }
  });

  it("trading tools are dangerous", () => {
    const dangerousTools = ["place_order", "cancel_order", "close_position", "close_all_positions"];
    for (const name of dangerousTools) {
      expect(findTool(tools, name).riskLevel).toBe("dangerous");
    }
  });
});

// ─── Futures not enabled guard ──────────────────────────────────

describe("futures not enabled guard", () => {
  const tools = createBuiltinTools("test-sandbox");

  it.each([
    "check_equity",
    "check_positions",
    "get_market_snapshot",
    "get_pnl_report",
    "place_order",
    "cancel_order",
    "close_position",
    "close_all_positions",
  ])("'%s' returns error when futures not configured", async (name) => {
    const ctx = createToolContext({ futures: null });
    const tool = findTool(tools, name);
    const result = await tool.execute(
      { instrument_id: "IF2403", direction: "buy", order_type: "market", offset: "open", volume: 1, order_id: "test" },
      ctx,
    );
    expect(result).toBe("Futures mode not enabled.");
  });
});

// ─── check_equity ───────────────────────────────────────────────

describe("check_equity", () => {
  const tools = createBuiltinTools("test-sandbox");

  it("returns account equity summary with survival tier", async () => {
    const ctx = createToolContext();
    const tool = findTool(tools, "check_equity");
    const result = await tool.execute({}, ctx);

    expect(result).toContain("Futures Account");
    expect(result).toContain("Dynamic Equity");
    expect(result).toContain("1,000,000.00");
    expect(result).toContain("Survival Tier: normal");
  });

  it("includes inference spent from KV", async () => {
    const ctx = createToolContext();
    ctx.db.setKV("inference_spent_cny", "5000");
    const tool = findTool(tools, "check_equity");
    const result = await tool.execute({}, ctx);

    expect(result).toContain("Inference Spent");
    expect(result).toContain("5,000.00");
  });
});

// ─── check_positions ────────────────────────────────────────────

describe("check_positions", () => {
  const tools = createBuiltinTools("test-sandbox");

  it("returns 'No open positions' when empty", async () => {
    const ctx = createToolContext();
    const tool = findTool(tools, "check_positions");
    const result = await tool.execute({}, ctx);
    expect(result).toBe("No open positions.");
  });

  it("lists positions with P&L and margin", async () => {
    const futures = new MockFuturesClient();
    const position: FuturesPosition = {
      instrumentId: "IF2403",
      instrumentName: "IF2403",
      direction: "long",
      volume: 2,
      openPrice: 4900,
      currentPrice: 5000,
      floatingPnl: 60000,
      margin: 200000,
      openDate: "2024-03-01",
    };
    futures.positions = [position];

    const ctx = createToolContext({ futures });
    const tool = findTool(tools, "check_positions");
    const result = await tool.execute({}, ctx);

    expect(result).toContain("IF2403");
    expect(result).toContain("LONG");
    expect(result).toContain("x2");
    expect(result).toContain("4900");
    expect(result).toContain("5000");
    expect(result).toContain("60,000.00");
  });
});

// ─── get_market_snapshot ────────────────────────────────────────

describe("get_market_snapshot", () => {
  const tools = createBuiltinTools("test-sandbox");

  it("returns market data for instrument", async () => {
    const ctx = createToolContext();
    const tool = findTool(tools, "get_market_snapshot");
    const result = await tool.execute({ instrument_id: "IF2403" }, ctx);

    expect(result).toContain("IF2403");
    expect(result).toContain("Last: 5000");
    expect(result).toContain("Bid: 4999");
    expect(result).toContain("Ask: 5001");
    expect(result).toContain("Volume:");
  });
});

// ─── get_pnl_report ─────────────────────────────────────────────

describe("get_pnl_report", () => {
  const tools = createBuiltinTools("test-sandbox");

  it("returns P&L summary", async () => {
    const ctx = createToolContext();
    const tool = findTool(tools, "get_pnl_report");
    const result = await tool.execute({}, ctx);

    expect(result).toContain("P&L Report");
    expect(result).toContain("Today Realized");
    expect(result).toContain("Floating (Unrealized)");
    expect(result).toContain("Total");
  });
});

// ─── place_order ────────────────────────────────────────────────

describe("place_order", () => {
  const tools = createBuiltinTools("test-sandbox");

  it("places a market order successfully", async () => {
    const ctx = createToolContext();
    const tool = findTool(tools, "place_order");
    const result = await tool.execute(
      {
        instrument_id: "IF2403",
        direction: "buy",
        order_type: "market",
        offset: "open",
        volume: 1,
      },
      ctx,
    );

    expect(result).toContain("Order filled");
    expect(result).toContain("buy open 1x IF2403");
    expect(result).toContain("id:");
  });

  it("reports rejection when order fails", async () => {
    const futures = new MockFuturesClient();
    futures.placeOrder = async () => ({
      success: false,
      error: "Insufficient margin",
      status: "rejected" as const,
      filledVolume: 0,
      filledPrice: 0,
      timestamp: new Date().toISOString(),
    });

    const ctx = createToolContext({ futures });
    const tool = findTool(tools, "place_order");
    const result = await tool.execute(
      {
        instrument_id: "IF2403",
        direction: "buy",
        order_type: "market",
        offset: "open",
        volume: 1,
      },
      ctx,
    );

    expect(result).toContain("Order rejected");
    expect(result).toContain("Insufficient margin");
  });
});

// ─── cancel_order ───────────────────────────────────────────────

describe("cancel_order", () => {
  const tools = createBuiltinTools("test-sandbox");

  it("cancels an order successfully", async () => {
    const ctx = createToolContext();
    const tool = findTool(tools, "cancel_order");
    const result = await tool.execute({ order_id: "order_123" }, ctx);
    expect(result).toBe("Order order_123 cancelled.");
  });

  it("reports failure when cancel fails", async () => {
    const futures = new MockFuturesClient();
    futures.cancelOrder = async () => ({
      success: false,
      error: "Order already filled",
    });

    const ctx = createToolContext({ futures });
    const tool = findTool(tools, "cancel_order");
    const result = await tool.execute({ order_id: "order_123" }, ctx);
    expect(result).toContain("Cancel failed");
    expect(result).toContain("Order already filled");
  });
});

// ─── close_position ─────────────────────────────────────────────

describe("close_position", () => {
  const tools = createBuiltinTools("test-sandbox");

  it("closes a position successfully", async () => {
    const ctx = createToolContext();
    const tool = findTool(tools, "close_position");
    const result = await tool.execute(
      { instrument_id: "IF2403", direction: "long" },
      ctx,
    );

    expect(result).toContain("Position closed");
    expect(result).toContain("IF2403");
    expect(result).toContain("long");
  });

  it("reports failure when close fails", async () => {
    const futures = new MockFuturesClient();
    futures.closePosition = async () => ({
      success: false,
      error: "No matching position",
      status: "rejected" as const,
      filledVolume: 0,
      filledPrice: 0,
      timestamp: new Date().toISOString(),
    });

    const ctx = createToolContext({ futures });
    const tool = findTool(tools, "close_position");
    const result = await tool.execute(
      { instrument_id: "IF2403", direction: "long" },
      ctx,
    );
    expect(result).toContain("Close failed");
    expect(result).toContain("No matching position");
  });
});

// ─── close_all_positions ────────────────────────────────────────

describe("close_all_positions", () => {
  const tools = createBuiltinTools("test-sandbox");

  it("returns 'No positions' when nothing to close", async () => {
    const ctx = createToolContext();
    const tool = findTool(tools, "close_all_positions");
    const result = await tool.execute({}, ctx);
    expect(result).toBe("No positions to close.");
  });

  it("reports summary of closed positions", async () => {
    const futures = new MockFuturesClient();
    futures.closeAllPositions = async () => [
      {
        success: true,
        orderId: "close_1",
        status: "filled" as const,
        filledVolume: 2,
        filledPrice: 5000,
        timestamp: new Date().toISOString(),
      },
      {
        success: false,
        error: "Market closed",
        status: "rejected" as const,
        filledVolume: 0,
        filledPrice: 0,
        timestamp: new Date().toISOString(),
      },
    ];

    const ctx = createToolContext({ futures });
    const tool = findTool(tools, "close_all_positions");
    const result = await tool.execute({}, ctx);

    expect(result).toContain("Closed 1/2 positions");
    expect(result).toContain("OK closed");
    expect(result).toContain("FAIL: Market closed");
  });
});

// ─── fund_child (modified for virtual capital) ──────────────────

describe("fund_child (virtual capital)", () => {
  const tools = createBuiltinTools("test-sandbox");

  it("blocks when futures not enabled", async () => {
    const ctx = createToolContext({ futures: null });
    const tool = findTool(tools, "fund_child");
    const result = await tool.execute(
      { child_id: "child-1", amount_cny: 50000 },
      ctx,
    );
    expect(result).toContain("Futures mode not enabled");
  });

  it("blocks when amount exceeds half available equity", async () => {
    const futures = new MockFuturesClient();
    futures.account.available = 100_000;

    const db = createTestDb();
    // Insert a child in wallet_verified state
    db.insertChild({
      id: "child-1",
      name: "test-child",
      address: "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`,
      sandboxId: "child-sandbox",
      genesisPrompt: "test",
      fundedAmountCents: 0,
      status: "wallet_verified",
      createdAt: new Date().toISOString(),
    });

    const ctx = createToolContext({ futures, db });
    const tool = findTool(tools, "fund_child");
    const result = await tool.execute(
      { child_id: "child-1", amount_cny: 60000 },
      ctx,
    );
    expect(result).toContain("Blocked");
    expect(result).toContain("Self-preservation");
  });

  it("allocates virtual capital and records in KV", async () => {
    const futures = new MockFuturesClient();
    const db = createTestDb();
    db.insertChild({
      id: "child-1",
      name: "test-child",
      address: "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`,
      sandboxId: "child-sandbox",
      genesisPrompt: "test",
      fundedAmountCents: 0,
      status: "wallet_verified",
      createdAt: new Date().toISOString(),
    });

    const ctx = createToolContext({ futures, db });
    const tool = findTool(tools, "fund_child");
    const result = await tool.execute(
      { child_id: "child-1", amount_cny: 50000 },
      ctx,
    );

    expect(result).toContain("Allocated");
    expect(result).toContain("50,000.00");
    expect(result).toContain("test-child");

    // Verify KV stored
    const stored = db.getKV("child_capital_child-1");
    expect(stored).toBe("50000");
  });

  it("accumulates virtual capital across multiple allocations", async () => {
    const futures = new MockFuturesClient();
    const db = createTestDb();
    db.insertChild({
      id: "child-1",
      name: "test-child",
      address: "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`,
      sandboxId: "child-sandbox",
      genesisPrompt: "test",
      fundedAmountCents: 0,
      status: "funded",
      createdAt: new Date().toISOString(),
    });

    const ctx = createToolContext({ futures, db });
    const tool = findTool(tools, "fund_child");

    await tool.execute({ child_id: "child-1", amount_cny: 30000 }, ctx);
    const result = await tool.execute({ child_id: "child-1", amount_cny: 20000 }, ctx);

    expect(result).toContain("50,000.00");
    expect(db.getKV("child_capital_child-1")).toBe("50000");
  });
});
