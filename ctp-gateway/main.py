"""
Futures Gateway - FastAPI REST Service

Wraps TqSdk (天勤量化) into a REST API that the Automaton
TypeScript runtime can call.

Endpoints:
  GET  /health              - Gateway health check
  GET  /account             - Query account equity and margin
  GET  /positions           - List open positions
  POST /orders              - Place a new order
  DELETE /orders/{id}       - Cancel a pending order
  POST /orders/{id}/close   - Close a specific position
  POST /positions/close-all - Close all positions
  GET  /market/{instrument} - Market snapshot
  GET  /pnl                 - Today's P&L summary

Usage:
  python main.py                          # Start with default config
  python main.py --port 8400              # Custom port
  python main.py --user-id 18721807537    # TqAuth phone number
"""

import argparse
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException

from config import TqConfig
from tq_client import TqClient
from models import (
    ClosePositionRequest,
    FuturesAccount,
    FuturesPosition,
    MarketSnapshot,
    OrderRequest,
    OrderResult,
    PnlSummary,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("futures-gateway")

# Global client instance
client: TqClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Connect to TqSdk on startup, disconnect on shutdown."""
    global client
    if client:
        logger.info("Connecting to TqSdk...")
        ok = await client.connect()
        if ok:
            logger.info("TqSdk connected successfully")
        else:
            logger.error("TqSdk connection failed, running in degraded mode")
    yield
    if client:
        logger.info("Disconnecting TqSdk...")
        await client.disconnect()
    logger.info("Futures Gateway shutting down")


app = FastAPI(
    title="Futures Gateway",
    description="REST API bridge for TqSdk futures trading",
    version="0.2.0",
    lifespan=lifespan,
)


# ─── Health ──────────────────────────────────────────────────────


@app.get("/health")
async def health():
    connected = client.is_connected if client else False
    return {"connected": connected, "status": "ok" if connected else "degraded"}


# ─── Account ────────────────────────────────────────────────────


@app.get("/account", response_model=FuturesAccount)
async def get_account():
    if not client:
        raise HTTPException(503, "Client not initialized")
    try:
        return await client.get_account()
    except Exception as e:
        raise HTTPException(500, f"Account query failed: {e}")


# ─── Positions ──────────────────────────────────────────────────


@app.get("/positions", response_model=list[FuturesPosition])
async def get_positions():
    if not client:
        raise HTTPException(503, "Client not initialized")
    try:
        return await client.get_positions()
    except Exception as e:
        raise HTTPException(500, f"Position query failed: {e}")


# ─── Orders ─────────────────────────────────────────────────────


@app.post("/orders", response_model=OrderResult)
async def place_order(order: OrderRequest):
    if not client:
        raise HTTPException(503, "Client not initialized")
    try:
        return await client.place_order(order)
    except Exception as e:
        raise HTTPException(500, f"Order placement failed: {e}")


@app.delete("/orders/{order_id}")
async def cancel_order(order_id: str):
    if not client:
        raise HTTPException(503, "Client not initialized")
    try:
        return await client.cancel_order(order_id)
    except Exception as e:
        raise HTTPException(500, f"Order cancellation failed: {e}")


@app.post("/orders/{instrument_id}/close", response_model=OrderResult)
async def close_position(instrument_id: str, req: ClosePositionRequest):
    """Close a specific position by instrument and direction."""
    if not client:
        raise HTTPException(503, "Client not initialized")

    # Find the matching position
    positions = await client.get_positions()
    matching = [
        p for p in positions
        if p.instrumentId == instrument_id and p.direction == req.direction
    ]

    if not matching:
        raise HTTPException(404, f"No {req.direction.value} position found for {instrument_id}")

    position = matching[0]
    close_volume = req.volume if req.volume else position.volume

    order = OrderRequest(
        instrumentId=instrument_id,
        direction="sell" if req.direction.value == "long" else "buy",
        orderType="market",
        offset="close",
        volume=close_volume,
    )

    try:
        return await client.place_order(order)
    except Exception as e:
        raise HTTPException(500, f"Close position failed: {e}")


@app.post("/positions/close-all", response_model=list[OrderResult])
async def close_all_positions():
    """Close all open positions."""
    if not client:
        raise HTTPException(503, "Client not initialized")

    positions = await client.get_positions()
    results: list[OrderResult] = []

    for pos in positions:
        order = OrderRequest(
            instrumentId=pos.instrumentId,
            direction="sell" if pos.direction.value == "long" else "buy",
            orderType="market",
            offset="close",
            volume=pos.volume,
        )
        try:
            result = await client.place_order(order)
            results.append(result)
        except Exception as e:
            logger.error(f"Failed to close {pos.instrumentId}: {e}")

    return results


# ─── Market Data ────────────────────────────────────────────────


@app.get("/market/{instrument_id}", response_model=MarketSnapshot)
async def get_market_snapshot(instrument_id: str):
    """Get latest market data for an instrument."""
    if not client:
        raise HTTPException(503, "Client not initialized")
    try:
        return await client.get_market_snapshot(instrument_id)
    except Exception as e:
        raise HTTPException(500, f"Market data failed: {e}")


# ─── P&L ────────────────────────────────────────────────────────


@app.get("/pnl", response_model=PnlSummary)
async def get_pnl():
    if not client:
        raise HTTPException(503, "Client not initialized")
    try:
        return await client.get_pnl()
    except Exception as e:
        raise HTTPException(500, f"PnL query failed: {e}")


# ─── CLI Entry Point ────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Futures Gateway REST Service")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address")
    parser.add_argument("--port", type=int, default=8400, help="Port number")
    parser.add_argument("--user-id", default="", help="TqAuth phone number")
    parser.add_argument("--password", default="", help="TqAuth password")
    parser.add_argument("--balance", type=float, default=10_000_000, help="TqSim initial balance")
    parser.add_argument(
        "--instruments",
        nargs="*",
        default=[],
        help="Instruments to subscribe on startup (e.g., SHFE.rb2510 DCE.m2509)",
    )
    args = parser.parse_args()

    config = TqConfig(
        user_id=args.user_id,
        password=args.password,
        host=args.host,
        port=args.port,
        initial_balance=args.balance,
        default_instruments=args.instruments,
    )

    global client
    client = TqClient(config)

    import uvicorn

    logger.info(f"Starting Futures Gateway on {config.host}:{config.port}")
    logger.info(f"Sim balance: {config.initial_balance:,.0f} CNY")
    if config.default_instruments:
        logger.info(f"Default instruments: {', '.join(config.default_instruments)}")
    uvicorn.run(app, host=config.host, port=config.port, log_level="info")


if __name__ == "__main__":
    main()
