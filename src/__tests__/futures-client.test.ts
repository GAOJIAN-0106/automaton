/**
 * Futures Gateway Client Tests
 *
 * TDD RED phase: Tests the HTTP client that communicates
 * with the CTP Gateway Python service.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FuturesHttpClient } from "../futures/client.js";
import type {
  FuturesAccount,
  FuturesPosition,
  OrderResult,
  MarketSnapshot,
} from "../futures/types.js";

// ─── Mock fetch ─────────────────────────────────────────────────

function mockFetchResponse(data: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    }),
  );
}

function mockFetchError(message: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error(message)),
  );
}

// ─── Tests ──────────────────────────────────────────────────────

describe("FuturesHttpClient", () => {
  let client: FuturesHttpClient;

  beforeEach(() => {
    client = new FuturesHttpClient("http://127.0.0.1:8400");
    vi.restoreAllMocks();
  });

  describe("getAccount", () => {
    it("returns account data from gateway", async () => {
      const mockAccount: FuturesAccount = {
        staticEquity: 1_000_000,
        dynamicEquity: 1_050_000,
        available: 850_000,
        margin: 200_000,
        floatingPnl: 50_000,
        todayPnl: 30_000,
        riskRatio: 0.19,
        timestamp: "2026-02-24T10:00:00Z",
      };
      mockFetchResponse(mockAccount);

      const result = await client.getAccount();
      expect(result).toEqual(mockAccount);
      expect(fetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8400/account",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("throws on gateway error", async () => {
      mockFetchError("Connection refused");
      await expect(client.getAccount()).rejects.toThrow("Connection refused");
    });

    it("throws on non-200 response", async () => {
      mockFetchResponse({ error: "CTP not connected" }, 503);
      await expect(client.getAccount()).rejects.toThrow();
    });
  });

  describe("getPositions", () => {
    it("returns positions array from gateway", async () => {
      const mockPositions: FuturesPosition[] = [
        {
          instrumentId: "IF2403",
          instrumentName: "沪深300指数期货2403",
          direction: "long",
          volume: 2,
          openPrice: 3500,
          currentPrice: 3550,
          floatingPnl: 30_000,
          margin: 200_000,
          openDate: "2026-02-24",
        },
      ];
      mockFetchResponse(mockPositions);

      const result = await client.getPositions();
      expect(result).toEqual(mockPositions);
      expect(result).toHaveLength(1);
      expect(result[0].instrumentId).toBe("IF2403");
    });

    it("returns empty array when no positions", async () => {
      mockFetchResponse([]);
      const result = await client.getPositions();
      expect(result).toEqual([]);
    });
  });

  describe("placeOrder", () => {
    it("sends order request and returns result", async () => {
      const mockResult: OrderResult = {
        success: true,
        orderId: "ORD_001",
        status: "filled",
        filledVolume: 1,
        filledPrice: 3500,
        timestamp: "2026-02-24T10:00:00Z",
      };
      mockFetchResponse(mockResult);

      const result = await client.placeOrder({
        instrumentId: "IF2403",
        direction: "buy",
        orderType: "market",
        offset: "open",
        volume: 1,
      });

      expect(result.success).toBe(true);
      expect(result.orderId).toBe("ORD_001");
      expect(fetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8400/orders",
        expect.objectContaining({
          method: "POST",
          body: expect.any(String),
        }),
      );
    });

    it("returns error on rejection", async () => {
      const mockResult: OrderResult = {
        success: false,
        error: "Insufficient margin",
        status: "rejected",
        filledVolume: 0,
        filledPrice: 0,
        timestamp: "2026-02-24T10:00:00Z",
      };
      mockFetchResponse(mockResult);

      const result = await client.placeOrder({
        instrumentId: "IF2403",
        direction: "buy",
        orderType: "limit",
        offset: "open",
        volume: 100,
        price: 3500,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Insufficient margin");
    });
  });

  describe("cancelOrder", () => {
    it("cancels order by ID", async () => {
      mockFetchResponse({ success: true });

      const result = await client.cancelOrder("ORD_001");
      expect(result.success).toBe(true);
      expect(fetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8400/orders/ORD_001",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  describe("closePosition", () => {
    it("closes a specific position", async () => {
      const mockResult: OrderResult = {
        success: true,
        orderId: "ORD_002",
        status: "filled",
        filledVolume: 2,
        filledPrice: 3550,
        timestamp: "2026-02-24T10:00:00Z",
      };
      mockFetchResponse(mockResult);

      const result = await client.closePosition("IF2403", "long");
      expect(result.success).toBe(true);
    });

    it("closes partial volume", async () => {
      const mockResult: OrderResult = {
        success: true,
        orderId: "ORD_003",
        status: "filled",
        filledVolume: 1,
        filledPrice: 3550,
        timestamp: "2026-02-24T10:00:00Z",
      };
      mockFetchResponse(mockResult);

      const result = await client.closePosition("IF2403", "long", 1);
      expect(result.success).toBe(true);
      expect(result.filledVolume).toBe(1);
    });
  });

  describe("getMarketSnapshot", () => {
    it("returns market data for instrument", async () => {
      const mockSnapshot: MarketSnapshot = {
        instrumentId: "IF2403",
        lastPrice: 3550,
        bidPrice: 3549.8,
        bidVolume: 50,
        askPrice: 3550.2,
        askVolume: 30,
        openPrice: 3500,
        highPrice: 3560,
        lowPrice: 3490,
        preClosePrice: 3480,
        upperLimit: 3828,
        lowerLimit: 3132,
        volume: 50000,
        turnover: 175_000_000_000,
        openInterest: 120_000,
        timestamp: "2026-02-24T10:00:00Z",
      };
      mockFetchResponse(mockSnapshot);

      const result = await client.getMarketSnapshot("IF2403");
      expect(result.instrumentId).toBe("IF2403");
      expect(result.lastPrice).toBe(3550);
    });
  });

  describe("isConnected", () => {
    it("returns true when gateway responds", async () => {
      mockFetchResponse({ connected: true });
      const result = await client.isConnected();
      expect(result).toBe(true);
    });

    it("returns false when gateway is down", async () => {
      mockFetchError("Connection refused");
      const result = await client.isConnected();
      expect(result).toBe(false);
    });
  });
});
