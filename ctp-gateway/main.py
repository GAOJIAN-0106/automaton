"""
CTP Gateway - FastAPI REST Service

Wraps CTP (Comprehensive Transaction Platform) into a REST API
that the Automaton TypeScript runtime can call.

Endpoints:
  GET  /health           - Gateway health check
  GET  /account          - Query account equity and margin
  GET  /positions        - List open positions
  POST /orders           - Place a new order
  DELETE /orders/{id}    - Cancel a pending order
  POST /orders/{id}/close - Close a specific position
  POST /positions/close-all - Close all positions
  GET  /market/{instrument} - Market snapshot
  GET  /pnl              - Today's P&L summary

Usage:
  python main.py                    # Start with default config
  python main.py --port 8400        # Custom port
  python main.py --user-id XXXXX    # SimNow user ID
"""

import argparse
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from config import CtpConfig
from ctp_client import CtpClient
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
logger = logging.getLogger("ctp-gateway")

# Global CTP client instance
ctp_client: CtpClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Connect to CTP on startup, disconnect on shutdown."""
    global ctp_client
    if ctp_client:
        logger.info("Connecting to CTP...")
        ok = await ctp_client.connect()
        if ok:
            logger.info("CTP connected successfully")
        else:
            logger.error("CTP connection failed, running in degraded mode")
    yield
    logger.info("CTP Gateway shutting down")


app = FastAPI(
    title="CTP Gateway",
    description="REST API bridge for CTP futures trading",
    version="0.1.0",
    lifespan=lifespan,
)


# ─── Health ──────────────────────────────────────────────────────


@app.get("/health")
async def health():
    connected = ctp_client.is_connected if ctp_client else False
    return {"connected": connected, "status": "ok" if connected else "degraded"}


# ─── Account ────────────────────────────────────────────────────


@app.get("/account", response_model=FuturesAccount)
async def get_account():
    if not ctp_client:
        raise HTTPException(503, "CTP client not initialized")
    try:
        return await ctp_client.get_account()
    except Exception as e:
        raise HTTPException(500, f"Account query failed: {e}")


# ─── Positions ──────────────────────────────────────────────────


@app.get("/positions", response_model=list[FuturesPosition])
async def get_positions():
    if not ctp_client:
        raise HTTPException(503, "CTP client not initialized")
    try:
        return await ctp_client.get_positions()
    except Exception as e:
        raise HTTPException(500, f"Position query failed: {e}")


# ─── Orders ─────────────────────────────────────────────────────


@app.post("/orders", response_model=OrderResult)
async def place_order(order: OrderRequest):
    if not ctp_client:
        raise HTTPException(503, "CTP client not initialized")
    try:
        return await ctp_client.place_order(order)
    except Exception as e:
        raise HTTPException(500, f"Order placement failed: {e}")


@app.delete("/orders/{order_id}")
async def cancel_order(order_id: str):
    if not ctp_client:
        raise HTTPException(503, "CTP client not initialized")
    try:
        return await ctp_client.cancel_order(order_id)
    except Exception as e:
        raise HTTPException(500, f"Order cancellation failed: {e}")


@app.post("/orders/{instrument_id}/close", response_model=OrderResult)
async def close_position(instrument_id: str, req: ClosePositionRequest):
    """Close a specific position by instrument and direction."""
    if not ctp_client:
        raise HTTPException(503, "CTP client not initialized")

    # Build a close order from the position info
    positions = await ctp_client.get_positions()
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
        return await ctp_client.place_order(order)
    except Exception as e:
        raise HTTPException(500, f"Close position failed: {e}")


@app.post("/positions/close-all", response_model=list[OrderResult])
async def close_all_positions():
    """Close all open positions."""
    if not ctp_client:
        raise HTTPException(503, "CTP client not initialized")

    positions = await ctp_client.get_positions()
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
            result = await ctp_client.place_order(order)
            results.append(result)
        except Exception as e:
            logger.error(f"Failed to close {pos.instrumentId}: {e}")

    return results


# ─── Market Data ────────────────────────────────────────────────


@app.get("/market/{instrument_id}", response_model=MarketSnapshot)
async def get_market_snapshot(instrument_id: str):
    """Get latest market data for an instrument.

    Note: Full market data subscription requires the MD API (mdapi).
    This is a placeholder that returns cached data or raises 501.
    """
    raise HTTPException(501, "Market data subscription not yet implemented. Use CTP MD API.")


# ─── P&L ────────────────────────────────────────────────────────


@app.get("/pnl", response_model=PnlSummary)
async def get_pnl():
    if not ctp_client:
        raise HTTPException(503, "CTP client not initialized")
    try:
        return await ctp_client.get_pnl()
    except Exception as e:
        raise HTTPException(500, f"PnL query failed: {e}")


# ─── CLI Entry Point ────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="CTP Gateway REST Service")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address")
    parser.add_argument("--port", type=int, default=8400, help="Port number")
    parser.add_argument("--broker-id", default="9999", help="CTP Broker ID")
    parser.add_argument("--user-id", default="", help="CTP User ID (SimNow investor code)")
    parser.add_argument("--password", default="", help="CTP Password")
    parser.add_argument("--td-address", help="Trade server address")
    parser.add_argument("--md-address", help="Market data server address")
    parser.add_argument("--use-openctp", action="store_true", default=True, help="Use OpenCTP TTS")
    args = parser.parse_args()

    config = CtpConfig(
        broker_id=args.broker_id,
        user_id=args.user_id,
        password=args.password,
        host=args.host,
        port=args.port,
        use_openctp=args.use_openctp,
    )

    if args.td_address:
        config.td_address = args.td_address
    if args.md_address:
        config.md_address = args.md_address

    global ctp_client
    ctp_client = CtpClient(config)

    import uvicorn

    logger.info(f"Starting CTP Gateway on {config.host}:{config.port}")
    logger.info(f"TD: {config.td_address}, MD: {config.md_address}")
    uvicorn.run(app, host=config.host, port=config.port, log_level="info")


if __name__ == "__main__":
    main()
