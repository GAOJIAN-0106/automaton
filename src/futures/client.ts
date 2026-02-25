/**
 * Futures Gateway HTTP Client
 *
 * Communicates with the CTP Gateway Python service via REST API.
 * Replaces conway/client.ts for financial operations.
 */

import type {
  FuturesAccount,
  FuturesGatewayClient,
  FuturesPosition,
  KlineBar,
  KlineInterval,
  MarketSnapshot,
  OrderRequest,
  OrderResult,
  PositionDirection,
} from "./types.js";

export class FuturesHttpClient implements FuturesGatewayClient {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = 10_000) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  async getAccount(): Promise<FuturesAccount> {
    return this.request<FuturesAccount>("GET", "/account");
  }

  async getPositions(): Promise<FuturesPosition[]> {
    return this.request<FuturesPosition[]>("GET", "/positions");
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    return this.request<OrderResult>("POST", "/orders", order);
  }

  async cancelOrder(orderId: string): Promise<{ success: boolean; error?: string }> {
    return this.request<{ success: boolean; error?: string }>(
      "DELETE",
      `/orders/${orderId}`,
    );
  }

  async closePosition(
    instrumentId: string,
    direction: PositionDirection,
    volume?: number,
  ): Promise<OrderResult> {
    return this.request<OrderResult>("POST", `/orders/${instrumentId}/close`, {
      direction,
      volume,
    });
  }

  async closeAllPositions(): Promise<OrderResult[]> {
    return this.request<OrderResult[]>("POST", "/positions/close-all");
  }

  async getMarketSnapshot(instrumentId: string): Promise<MarketSnapshot> {
    return this.request<MarketSnapshot>("GET", `/market/${instrumentId}`);
  }

  async getKline(
    instrumentId: string,
    interval: KlineInterval,
    limit = 100,
  ): Promise<KlineBar[]> {
    return this.request<KlineBar[]>(
      "GET",
      `/market/${instrumentId}/kline?interval=${interval}&limit=${limit}`,
    );
  }

  async getPnl(): Promise<{ todayPnl: number; floatingPnl: number; totalPnl: number }> {
    return this.request<{ todayPnl: number; floatingPnl: number; totalPnl: number }>(
      "GET",
      "/pnl",
    );
  }

  async isConnected(): Promise<boolean> {
    try {
      await this.request<unknown>("GET", "/health");
      return true;
    } catch {
      return false;
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `CTP Gateway error: ${response.status} ${text}`.trim(),
      );
    }

    return response.json() as Promise<T>;
  }
}
