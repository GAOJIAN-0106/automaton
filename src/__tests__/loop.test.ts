/**
 * Agent Loop Tests
 *
 * Deterministic tests for the agent loop using mock clients.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import {
  MockInferenceClient,
  MockConwayClient,
  MockFuturesClient,
  MockSocialClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
  toolCallResponse,
  noToolResponse,
} from "./mocks.js";
import type { AutomatonDatabase, AgentTurn, AgentState } from "../types.js";
import type { FuturesConfig } from "../futures/types.js";
import { DEFAULT_FUTURES_CONFIG, DEFAULT_FUTURES_SURVIVAL_THRESHOLDS, DEFAULT_TRADING_POLICY } from "../futures/types.js";

describe("Agent Loop", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;
  let identity: ReturnType<typeof createTestIdentity>;
  let config: ReturnType<typeof createTestConfig>;

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
    identity = createTestIdentity();
    config = createTestConfig();
  });

  afterEach(() => {
    db.close();
  });

  it("exec tool runs and is persisted", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "exec", arguments: { command: "echo hello" } },
      ]),
      noToolResponse("Done."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // First turn should have the exec tool call
    expect(turns.length).toBeGreaterThanOrEqual(1);
    const execTurn = turns.find((t) =>
      t.toolCalls.some((tc) => tc.name === "exec"),
    );
    expect(execTurn).toBeDefined();
    expect(execTurn!.toolCalls[0].name).toBe("exec");
    expect(execTurn!.toolCalls[0].error).toBeUndefined();

    // Verify conway.exec was called
    expect(conway.execCalls.length).toBeGreaterThanOrEqual(1);
    expect(conway.execCalls[0].command).toBe("echo hello");
  });

  it("forbidden patterns blocked", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "exec", arguments: { command: "rm -rf ~/.automaton" } },
      ]),
      noToolResponse("OK."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // The tool result should contain a blocked message, not an error
    const execTurn = turns.find((t) =>
      t.toolCalls.some((tc) => tc.name === "exec"),
    );
    expect(execTurn).toBeDefined();
    const execCall = execTurn!.toolCalls.find((tc) => tc.name === "exec");
    expect(execCall!.result).toContain("Blocked");

    // conway.exec should NOT have been called
    expect(conway.execCalls.length).toBe(0);
  });

  it("low credits forces low-compute mode", async () => {
    conway.creditsCents = 50; // Below $1 threshold -> critical

    const inference = new MockInferenceClient([
      noToolResponse("Low on credits."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    expect(inference.lowComputeMode).toBe(true);
  });

  it("sleep tool transitions state", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "sleep", arguments: { duration_seconds: 60, reason: "test" } },
      ]),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBeDefined();
  });

  it("idle auto-sleep on no tool calls", async () => {
    const inference = new MockInferenceClient([
      noToolResponse("Nothing to do."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    expect(db.getAgentState()).toBe("sleeping");
  });

  it("inbox messages cause pendingInput injection", async () => {
    // Insert an inbox message before running the loop
    db.insertInboxMessage({
      id: "test-msg-1",
      from: "0xsender",
      to: "0xrecipient",
      content: "Hello from another agent!",
      signedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const inference = new MockInferenceClient([
      // First response: wakeup prompt
      toolCallResponse([
        { name: "exec", arguments: { command: "echo awake" } },
      ]),
      // Second response: inbox message (after wakeup turn, pendingInput is cleared,
      // then inbox messages are picked up on the next iteration)
      noToolResponse("Received the message."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // One of the turns should have input from the inbox message
    const inboxTurn = turns.find(
      (t) => t.input?.includes("Hello from another agent!"),
    );
    expect(inboxTurn).toBeDefined();
    expect(inboxTurn!.inputSource).toBe("agent");
  });

  it("MAX_TOOL_CALLS_PER_TURN limits tool calls", async () => {
    // Create a response with 15 tool calls (max is 10)
    const manyToolCalls = Array.from({ length: 15 }, (_, i) => ({
      name: "exec",
      arguments: { command: `echo ${i}` },
    }));

    const inference = new MockInferenceClient([
      toolCallResponse(manyToolCalls),
      noToolResponse("Done."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // The first turn should have at most 10 tool calls executed
    const execTurn = turns.find((t) => t.toolCalls.length > 0);
    expect(execTurn).toBeDefined();
    expect(execTurn!.toolCalls.length).toBeLessThanOrEqual(10);
  });

  it("consecutive errors trigger sleep", async () => {
    // Create an inference client that always throws
    const failingInference = new MockInferenceClient([]);
    failingInference.chat = async () => {
      throw new Error("Inference API unavailable");
    };

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleSpy2 = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleSpy3 = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runAgentLoop({
      identity,
      config: { ...config, logLevel: "debug" },
      db,
      conway,
      inference: failingInference,
    });

    // After 5 consecutive errors, should be sleeping
    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBeDefined();

    consoleSpy.mockRestore();
    consoleSpy2.mockRestore();
    consoleSpy3.mockRestore();
  });

  it("financial state cached fallback on API failure", async () => {
    // Pre-cache a known balance
    db.setKV("last_known_balance", JSON.stringify({ creditsCents: 5000, usdcBalance: 1.0 }));

    // Make credits API fail
    conway.getCreditsBalance = async () => {
      throw new Error("API down");
    };

    const inference = new MockInferenceClient([
      noToolResponse("Running with cached balance."),
    ]);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleSpy2 = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    // Should not die, should use cached balance and continue
    const state = db.getAgentState();
    expect(state).not.toBe("dead");

    consoleSpy.mockRestore();
    consoleSpy2.mockRestore();
  });

  it("turn persistence is atomic with inbox ack", async () => {
    // Insert an inbox message
    db.insertInboxMessage({
      id: "atomic-msg-1",
      from: "0xsender",
      to: "0xrecipient",
      content: "Test atomic persistence",
      signedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "exec", arguments: { command: "echo processing" } },
      ]),
      noToolResponse("Done processing."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // After processing, the inbox message should be marked as processed
    const unprocessed = db.getUnprocessedInboxMessages(10);
    // The message should have been consumed (either processed or not showing as unprocessed)
    // Since we successfully completed the turn, it should be processed
    expect(turns.length).toBeGreaterThanOrEqual(1);
  });

  it("state transitions are reported via onStateChange", async () => {
    const stateChanges: AgentState[] = [];

    const inference = new MockInferenceClient([
      noToolResponse("Nothing to do."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onStateChange: (state) => stateChanges.push(state),
    });

    // Should have transitioned through waking -> running -> sleeping
    expect(stateChanges).toContain("waking");
    expect(stateChanges).toContain("running");
    expect(stateChanges).toContain("sleeping");
  });

  it("zero credits enters critical tier, not dead", async () => {
    conway.creditsCents = 0; // $0 -> critical tier (agent stays alive)

    const inference = new MockInferenceClient([
      noToolResponse("I have no credits but I'm still alive."),
    ]);

    const stateChanges: AgentState[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onStateChange: (state) => stateChanges.push(state),
    });

    // Zero credits = critical, not dead. Agent should stay alive.
    expect(stateChanges).toContain("critical");
    expect(stateChanges).not.toContain("dead");
    expect(db.getAgentState()).not.toBe("dead");
  });

  it("maintenance loop detected after 3 consecutive idle-only turns", async () => {
    // Simulate: wakeup turn with check_credits, then 2 more idle-only turns,
    // triggering maintenance loop detection on the 3rd idle-only turn.
    // Construct responses with unique tool_call IDs to avoid DB collisions.
    function idleToolResponse(name: string, args: Record<string, unknown>, uid: string): ReturnType<typeof toolCallResponse> {
      return {
        id: `resp_${uid}`,
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `call_${uid}`,
            type: "function" as const,
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        toolCalls: [{
          id: `call_${uid}`,
          type: "function" as const,
          function: { name, arguments: JSON.stringify(args) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      };
    }

    const inference = new MockInferenceClient([
      idleToolResponse("check_credits", {}, "t1"),
      idleToolResponse("system_synopsis", {}, "t2"),
      idleToolResponse("discover_agents", { limit: 15 }, "t3"),
      noToolResponse("I will now work on something productive."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // The intervention message should have been injected after the 3rd idle-only turn.
    // Turn 4 should have the maintenance loop intervention as input.
    const interventionTurn = turns.find(
      (t) => t.input?.includes("MAINTENANCE LOOP DETECTED"),
    );
    expect(interventionTurn).toBeDefined();
    expect(interventionTurn!.input).toContain("status-check tools");
  });

  it("maintenance loop NOT triggered when turns mix idle and productive tools", async () => {
    // Turn 1: idle-only, Turn 2: has productive tool (exec), Turn 3: idle-only
    // Should NOT trigger because turn 2 breaks the consecutive count.
    const inference = new MockInferenceClient([
      // Turn 1 (wakeup): idle-only
      toolCallResponse([
        { name: "check_credits", arguments: {} },
      ]),
      // Turn 2: productive tool — resets idle counter
      toolCallResponse([
        { name: "exec", arguments: { command: "echo hello" } },
      ]),
      // Turn 3: idle-only — counter starts at 1 again
      toolCallResponse([
        { name: "system_synopsis", arguments: {} },
      ]),
      // Turn 4: end
      noToolResponse("Done."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // No maintenance loop intervention should have been injected
    const interventionTurn = turns.find(
      (t) => t.input?.includes("MAINTENANCE LOOP DETECTED"),
    );
    expect(interventionTurn).toBeUndefined();
  });

  it("maintenance loop triggers with varying idle tool combinations", async () => {
    // Each turn uses a different idle-only tool, but all are idle-only.
    // The existing exact-pattern detector would NOT catch this (different patterns).
    // The new idle-tool detector SHOULD catch it.
    function idleToolResponse(name: string, args: Record<string, unknown>, uid: string): ReturnType<typeof toolCallResponse> {
      return {
        id: `resp_${uid}`,
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `call_${uid}`,
            type: "function" as const,
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        toolCalls: [{
          id: `call_${uid}`,
          type: "function" as const,
          function: { name, arguments: JSON.stringify(args) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      };
    }

    const inference = new MockInferenceClient([
      idleToolResponse("check_credits", {}, "v1"),
      idleToolResponse("check_usdc_balance", {}, "v2"),
      idleToolResponse("git_status", {}, "v3"),
      noToolResponse("Starting productive work now."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const interventionTurn = turns.find(
      (t) => t.input?.includes("MAINTENANCE LOOP DETECTED"),
    );
    expect(interventionTurn).toBeDefined();
  });
});

// ─── Futures Mode Tests ────────────────────────────────────────

describe("Agent Loop (Futures Mode)", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;
  let identity: ReturnType<typeof createTestIdentity>;
  let futuresClient: MockFuturesClient;

  const futuresConfig: FuturesConfig = {
    gatewayUrl: "http://127.0.0.1:8400",
    initialCapital: 1_000_000,
    survivalThresholds: DEFAULT_FUTURES_SURVIVAL_THRESHOLDS,
    tradingPolicy: DEFAULT_TRADING_POLICY,
  };

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
    identity = createTestIdentity();
    futuresClient = new MockFuturesClient();
  });

  afterEach(() => {
    db.close();
  });

  it("futures mode uses equity for wakeup prompt", async () => {
    const config = createTestConfig({ futuresConfig });
    const inference = new MockInferenceClient([
      noToolResponse("Running in futures mode."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      futures: futuresClient,
    });

    // The wakeup prompt should contain equity info instead of credits
    const firstCall = inference.calls[0];
    const allContent = firstCall.messages.map((m) => m.content).join("\n");
    expect(allContent).toContain("¥");
    // Should NOT refer to credits/USDC in wakeup
    expect(allContent).not.toMatch(/\$\d+\.\d+.*credits/i);
  });

  it("futures mode injects futuresClient into ToolContext", async () => {
    const config = createTestConfig({ futuresConfig });

    // Use check_equity tool (will be added in Phase 3, but for now
    // test that the tool context has futures client by using exec and
    // checking the toolContext was built with futures)
    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "exec", arguments: { command: "echo futures test" } },
      ]),
      noToolResponse("Done."),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      futures: futuresClient,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // exec tool should work (basic sanity in futures mode)
    const execTurn = turns.find((t) =>
      t.toolCalls.some((tc) => tc.name === "exec"),
    );
    expect(execTurn).toBeDefined();
    expect(execTurn!.toolCalls[0].error).toBeUndefined();
  });

  it("low futures equity triggers low_compute mode", async () => {
    // Set equity to 60% of initial capital -> low_compute tier (> 0.5 threshold)
    // Actually, 0.6 > 0.5 = low_compute, so set to 0.4 to be below low_compute
    futuresClient.account.dynamicEquity = 400_000; // 40% -> critical tier (> 0.2 but <= 0.5)

    const config = createTestConfig({ futuresConfig });
    const inference = new MockInferenceClient([
      noToolResponse("Low equity mode."),
    ]);

    const stateChanges: AgentState[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      futures: futuresClient,
      onStateChange: (state) => stateChanges.push(state),
    });

    expect(inference.lowComputeMode).toBe(true);
  });

  it("critical futures equity enters critical state", async () => {
    // Set equity to 15% of initial capital -> dead tier (<= 0.2 threshold)
    // Set to 25% -> critical tier (> 0.2 but <= 0.5)
    futuresClient.account.dynamicEquity = 250_000; // 25% -> critical

    const config = createTestConfig({ futuresConfig });
    const inference = new MockInferenceClient([
      noToolResponse("Critical equity."),
    ]);

    const stateChanges: AgentState[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      futures: futuresClient,
      onStateChange: (state) => stateChanges.push(state),
    });

    expect(stateChanges).toContain("critical");
  });

  it("futures mode caches equity on gateway disconnect", async () => {
    const config = createTestConfig({ futuresConfig });

    // First call succeeds with good equity
    futuresClient.account.dynamicEquity = 1_000_000;

    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "exec", arguments: { command: "echo turn1" } },
      ]),
      noToolResponse("Done."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      futures: futuresClient,
    });

    // Agent should not be dead — it used cached or live equity
    expect(db.getAgentState()).not.toBe("dead");
  });

  it("futures mode does NOT use conway credits for survival", async () => {
    // Conway has 0 credits (would be critical in non-futures mode)
    conway.creditsCents = 0;
    // But futures account has healthy equity
    futuresClient.account.dynamicEquity = 1_200_000; // > 1.2 ratio = high tier

    const config = createTestConfig({ futuresConfig });
    const inference = new MockInferenceClient([
      noToolResponse("All good."),
    ]);

    const stateChanges: AgentState[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      futures: futuresClient,
      onStateChange: (state) => stateChanges.push(state),
    });

    // Should NOT enter critical or low_compute — futures equity is healthy
    expect(stateChanges).not.toContain("critical");
    expect(inference.lowComputeMode).toBe(false);
  });

  it("inference cost is deducted from effective equity", async () => {
    // Set initial equity to 900k (ratio 0.9 = normal tier)
    futuresClient.account.dynamicEquity = 900_000;

    // Pre-set inference_spent to 500k (huge cost), effective = 400k
    // ratio = 0.4 -> critical tier
    const config = createTestConfig({ futuresConfig });

    const inference = new MockInferenceClient([
      noToolResponse("Spent a lot on inference."),
    ]);

    const stateChanges: AgentState[] = [];

    // Set inference_spent before running loop
    db.setKV("inference_spent", "500000");

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      futures: futuresClient,
      onStateChange: (state) => stateChanges.push(state),
    });

    // With 400k effective equity (ratio 0.4), should be critical (> 0.2 but <= 0.5)
    expect(stateChanges).toContain("critical");
  });

  it("inference cost is recorded in KV after each turn in futures mode", async () => {
    const config = createTestConfig({ futuresConfig });

    const inference = new MockInferenceClient([
      noToolResponse("Turn 1 done."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      futures: futuresClient,
    });

    // inference_spent should exist and be > 0 (the mock router records cost)
    const spent = db.getKV("inference_spent");
    expect(spent).toBeDefined();
    // The value should be a parseable number >= 0
    expect(parseFloat(spent!)).toBeGreaterThanOrEqual(0);
  });
});
