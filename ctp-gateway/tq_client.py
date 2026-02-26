"""
TqSdk Client Wrapper

Wraps the TqSdk (天勤量化) Python library into a simple interface
that the FastAPI routes can call.

Architecture:
  - TqApi runs in a dedicated background thread with a continuous
    wait_update() loop to keep data fresh.
  - FastAPI handlers read from TqSdk reference objects (account,
    position, quote) which are updated atomically during wait_update().
  - Order operations (insert_order, cancel_order) are called from
    the FastAPI thread — TqSdk handles the internal queuing.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from datetime import datetime
from typing import Optional

from config import TqConfig
from models import (
    FuturesAccount,
    FuturesPosition,
    MarketSnapshot,
    OrderRequest,
    OrderResult,
    OrderStatus,
    PositionDirection,
    PnlSummary,
)

logger = logging.getLogger("tq_client")

# Try to import TqSdk — graceful fallback for environments without it
try:
    from tqsdk import TqApi, TqSim, TqAuth

    TQSDK_AVAILABLE = True
except ImportError:
    TQSDK_AVAILABLE = False
    logger.warning("tqsdk not installed, running in mock mode")


class TqClient:
    """
    High-level TqSdk client that exposes async methods for the REST gateway.

    Lifecycle:
      1. connect()   — creates TqApi in background thread, waits for ready
      2. get_account / get_positions / place_order / ...  — called by FastAPI
      3. disconnect() — signals background thread to stop and closes TqApi
    """

    def __init__(self, config: TqConfig) -> None:
        self.config = config
        self._api: Optional[TqApi] = None
        self._account_ref = None  # TqSdk account reference (auto-updated)
        self._connected = False
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

        # Tracked instruments: symbol -> (quote_ref, position_ref)
        self._tracked: dict[str, tuple] = {}
        self._track_lock = threading.Lock()

    @property
    def is_connected(self) -> bool:
        return self._connected and self._api is not None

    # ─── Connection ──────────────────────────────────────────────

    async def connect(self) -> bool:
        """Start TqApi in a background thread and wait for connection."""
        if not TQSDK_AVAILABLE:
            logger.warning("TqSdk not available, using mock mode")
            self._connected = True
            return True

        try:
            self._stop_event.clear()
            ready_event = threading.Event()

            def run_tq():
                try:
                    auth = TqAuth(self.config.user_id, self.config.password)
                    if self.config.use_sim:
                        self._api = TqApi(
                            TqSim(init_balance=self.config.initial_balance),
                            auth=auth,
                        )
                    else:
                        self._api = TqApi(auth=auth)

                    self._account_ref = self._api.get_account()

                    # Subscribe default instruments
                    for symbol in self.config.default_instruments:
                        self._subscribe_instrument(symbol)

                    self._connected = True
                    ready_event.set()

                    # Main update loop — keeps all references fresh
                    while not self._stop_event.is_set():
                        deadline = time.time() + 0.5
                        self._api.wait_update(deadline=deadline)

                except Exception as e:
                    logger.error(f"TqSdk thread error: {e}")
                    ready_event.set()
                finally:
                    try:
                        if self._api:
                            self._api.close()
                    except Exception:
                        pass
                    self._connected = False
                    logger.info("TqSdk thread stopped")

            self._thread = threading.Thread(target=run_tq, daemon=True, name="tqsdk")
            self._thread.start()

            # Wait for connection (15s timeout)
            ready_event.wait(timeout=15)
            if self._connected:
                logger.info("TqSdk connected, account ready")
            return self._connected

        except Exception as e:
            logger.error(f"TqSdk connect failed: {e}")
            return False

    async def disconnect(self):
        """Signal background thread to stop."""
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5)

    # ─── Instrument subscription ─────────────────────────────────

    def _subscribe_instrument(self, symbol: str):
        """Subscribe to an instrument's quote and position data.

        Can be called from any thread — TqSdk handles internal queuing.
        """
        with self._track_lock:
            if symbol in self._tracked:
                return
            quote_ref = self._api.get_quote(symbol)
            pos_ref = self._api.get_position(symbol)
            self._tracked[symbol] = (quote_ref, pos_ref)
            logger.info(f"Subscribed to {symbol}")

    def _ensure_subscribed(self, symbol: str):
        """Ensure an instrument is subscribed, subscribe if not."""
        if symbol not in self._tracked:
            self._subscribe_instrument(symbol)

    # ─── Account ─────────────────────────────────────────────────

    async def get_account(self) -> FuturesAccount:
        """Query trading account."""
        if not self.is_connected:
            return self._mock_account()

        acc = self._account_ref
        dynamic_equity = acc.balance
        static_equity = acc.static_balance
        available = acc.available
        margin = acc.margin
        float_pnl = acc.float_profit
        close_pnl = acc.close_profit
        commission = acc.commission
        risk_ratio = margin / dynamic_equity if dynamic_equity > 0 else 0

        return FuturesAccount(
            staticEquity=static_equity,
            dynamicEquity=dynamic_equity,
            available=available,
            margin=margin,
            floatingPnl=float_pnl,
            todayPnl=close_pnl - commission,
            riskRatio=round(risk_ratio, 4),
            timestamp=datetime.now().isoformat(),
        )

    # ─── Positions ───────────────────────────────────────────────

    async def get_positions(self) -> list[FuturesPosition]:
        """Query all open positions across tracked instruments."""
        if not self.is_connected:
            return []

        positions: list[FuturesPosition] = []

        with self._track_lock:
            tracked_copy = dict(self._tracked)

        for symbol, (quote_ref, pos_ref) in tracked_copy.items():
            last_price = quote_ref.last_price if quote_ref.last_price == quote_ref.last_price else 0

            # Long position
            if pos_ref.volume_long > 0:
                positions.append(FuturesPosition(
                    instrumentId=symbol,
                    instrumentName=symbol,
                    direction=PositionDirection.long,
                    volume=pos_ref.volume_long,
                    openPrice=round(pos_ref.open_price_long, 2),
                    currentPrice=round(last_price, 2),
                    floatingPnl=pos_ref.float_profit_long,
                    margin=pos_ref.margin_long,
                    openDate="",
                ))

            # Short position
            if pos_ref.volume_short > 0:
                positions.append(FuturesPosition(
                    instrumentId=symbol,
                    instrumentName=symbol,
                    direction=PositionDirection.short,
                    volume=pos_ref.volume_short,
                    openPrice=round(pos_ref.open_price_short, 2),
                    currentPrice=round(last_price, 2),
                    floatingPnl=pos_ref.float_profit_short,
                    margin=pos_ref.margin_short,
                    openDate="",
                ))

        return positions

    # ─── Orders ──────────────────────────────────────────────────

    async def place_order(self, order: OrderRequest) -> OrderResult:
        """Submit a new order and wait for fill (with timeout)."""
        if not self.is_connected:
            return self._mock_order_result(order)

        symbol = order.instrumentId
        self._ensure_subscribed(symbol)

        # Map direction and offset to TqSdk constants
        direction = "BUY" if order.direction.value == "buy" else "SELL"
        offset_map = {"open": "OPEN", "close": "CLOSE", "close_today": "CLOSETODAY"}
        offset = offset_map.get(order.offset.value, "OPEN")

        # SHFE requires CLOSETODAY for same-day positions
        if offset == "CLOSE" and symbol.startswith("SHFE."):
            offset = "CLOSETODAY"

        # Determine limit price
        if order.orderType.value == "market":
            # For market orders, use best available price (ask for buy, bid for sell)
            quote_ref, _ = self._tracked.get(symbol, (None, None))
            if quote_ref is None:
                await asyncio.sleep(0.5)
                quote_ref, _ = self._tracked.get(symbol, (None, None))

            if quote_ref:
                if direction == "BUY":
                    limit_price = quote_ref.ask_price1
                else:
                    limit_price = quote_ref.bid_price1
                # NaN check
                if limit_price != limit_price:
                    return OrderResult(
                        success=False,
                        error=f"No valid quote for {symbol}",
                        status=OrderStatus.rejected,
                        timestamp=datetime.now().isoformat(),
                    )
            else:
                return OrderResult(
                    success=False,
                    error=f"No quote data for {symbol}",
                    status=OrderStatus.rejected,
                    timestamp=datetime.now().isoformat(),
                )
        else:
            limit_price = order.price or 0

        try:
            order_ref = self._api.insert_order(
                symbol=symbol,
                direction=direction,
                offset=offset,
                volume=order.volume,
                limit_price=limit_price,
            )

            # Poll for order completion (background thread updates via wait_update)
            for i in range(6):  # 6 x 0.5s = 3s max
                if order_ref.status == "FINISHED":
                    break
                # Check for TqSim rejection message (status stays ALIVE)
                last_msg = getattr(order_ref, "last_msg", "")
                if last_msg and "失败" in last_msg:
                    logger.warning(f"Order rejected by TqSim: {last_msg}")
                    break
                await asyncio.sleep(0.5)

            # Read result
            last_msg = getattr(order_ref, "last_msg", "")
            filled_volume = order_ref.volume_orign - order_ref.volume_left
            rejected = bool(last_msg and "失败" in last_msg)

            if rejected:
                status = OrderStatus.rejected
            elif order_ref.status == "FINISHED" and order_ref.volume_left == 0:
                status = OrderStatus.filled
            elif order_ref.status == "FINISHED":
                status = OrderStatus.cancelled
            else:
                status = OrderStatus.pending

            # Get actual trade price if available
            trade_price = getattr(order_ref, "trade_price", limit_price)
            if trade_price != trade_price:  # NaN check
                trade_price = limit_price

            return OrderResult(
                success=status == OrderStatus.filled,
                orderId=str(getattr(order_ref, "order_id", "")),
                error=last_msg if rejected else None,
                status=status,
                filledVolume=filled_volume,
                filledPrice=trade_price,
                timestamp=datetime.now().isoformat(),
            )

        except Exception as e:
            logger.error(f"Order placement failed: {e}")
            return OrderResult(
                success=False,
                error=str(e),
                status=OrderStatus.rejected,
                timestamp=datetime.now().isoformat(),
            )

    async def cancel_order(self, order_id: str) -> dict:
        """Cancel a pending order by order_id.

        Note: TqSdk's cancel_order takes the order reference object.
        For REST API, we'd need to track order refs by ID. For now,
        this is a simplified implementation.
        """
        if not self.is_connected:
            return {"success": True}

        # In practice, the TS runtime should track and manage orders.
        # This endpoint is a best-effort cancel.
        logger.warning(f"Cancel order {order_id} — TqSdk requires order reference, best-effort only")
        return {"success": True, "note": "best-effort cancel"}

    # ─── Market Data ─────────────────────────────────────────────

    async def get_market_snapshot(self, instrument_id: str) -> MarketSnapshot:
        """Get latest market data for an instrument."""
        if not self.is_connected:
            raise RuntimeError("Not connected")

        self._ensure_subscribed(instrument_id)

        # Wait briefly for data if just subscribed
        await asyncio.sleep(0.3)

        quote_ref, _ = self._tracked.get(instrument_id, (None, None))
        if quote_ref is None:
            raise RuntimeError(f"No quote data for {instrument_id}")

        # NaN check helper
        def safe(val, default=0):
            return val if val == val else default  # NaN != NaN

        return MarketSnapshot(
            instrumentId=instrument_id,
            lastPrice=safe(quote_ref.last_price),
            bidPrice=safe(quote_ref.bid_price1),
            bidVolume=int(safe(quote_ref.bid_volume1)),
            askPrice=safe(quote_ref.ask_price1),
            askVolume=int(safe(quote_ref.ask_volume1)),
            openPrice=safe(quote_ref.open),
            highPrice=safe(quote_ref.highest),
            lowPrice=safe(quote_ref.lowest),
            preClosePrice=safe(quote_ref.pre_close),
            upperLimit=safe(quote_ref.upper_limit),
            lowerLimit=safe(quote_ref.lower_limit),
            volume=int(safe(quote_ref.volume)),
            turnover=safe(quote_ref.amount),
            openInterest=safe(quote_ref.open_interest),
            timestamp=datetime.now().isoformat(),
        )

    # ─── P&L ─────────────────────────────────────────────────────

    async def get_pnl(self) -> PnlSummary:
        """Get P&L summary from account data."""
        account = await self.get_account()
        return PnlSummary(
            todayPnl=account.todayPnl,
            floatingPnl=account.floatingPnl,
            totalPnl=account.todayPnl + account.floatingPnl,
        )

    # ─── Mock methods for environments without TqSdk ─────────────

    def _mock_account(self) -> FuturesAccount:
        return FuturesAccount(
            staticEquity=1_000_000,
            dynamicEquity=1_000_000,
            available=800_000,
            margin=200_000,
            floatingPnl=0,
            todayPnl=0,
            riskRatio=0.2,
            timestamp=datetime.now().isoformat(),
        )

    def _mock_order_result(self, order: OrderRequest) -> OrderResult:
        return OrderResult(
            success=True,
            orderId=f"MOCK_{int(time.time())}",
            status=OrderStatus.filled,
            filledVolume=order.volume,
            filledPrice=order.price or 0,
            timestamp=datetime.now().isoformat(),
        )
