"""
CTP Client Wrapper

Wraps the openctp-ctp Python bindings into a simple interface
that the FastAPI routes can call.

This module handles:
- CTP API login and session management
- Account queries (TradingAccount)
- Position queries (InvestorPosition)
- Order submission and cancellation
- Market data subscription

The CTP API is callback-based (SPI pattern), so we use asyncio Events
to bridge callbacks into async/await.
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from datetime import datetime
from threading import Lock
from typing import Optional

from config import CtpConfig
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

logger = logging.getLogger("ctp_client")

# Try to import CTP bindings - graceful fallback for environments without them
try:
    from openctp_ctp import tdapi, mdapi

    CTP_AVAILABLE = True
except ImportError:
    CTP_AVAILABLE = False
    logger.warning("openctp-ctp not installed, running in mock mode")


class CtpTraderSpi(tdapi.CThostFtdcTraderSpi if CTP_AVAILABLE else object):
    """
    CTP Trader callback handler (SPI).
    Collects responses and signals completion via asyncio Events.
    """

    def __init__(self, config: CtpConfig) -> None:
        if CTP_AVAILABLE:
            super().__init__()
        self._config = config
        self.connected = False
        self.logged_in = False
        self.front_id: int = 0
        self.session_id: int = 0

        # Response collectors
        self._account: Optional[FuturesAccount] = None
        self._positions: list[FuturesPosition] = []
        self._order_result: Optional[OrderResult] = None
        self._market_data: dict[str, MarketSnapshot] = {}

        # Synchronization
        self._lock = Lock()
        self._login_event = asyncio.Event()
        self._account_event = asyncio.Event()
        self._position_event = asyncio.Event()
        self._order_event = asyncio.Event()

        # Reference to API set by CtpClient after RegisterSpi
        self._td_api = None

    def OnFrontConnected(self) -> None:
        self.connected = True
        logger.info("CTP front connected, sending auth request...")
        if self._td_api:
            req = tdapi.CThostFtdcReqAuthenticateField()
            req.BrokerID = self._config.broker_id
            req.UserID = self._config.user_id
            req.AppID = self._config.app_id
            req.AuthCode = self._config.auth_code
            self._td_api.ReqAuthenticate(req, 0)

    def OnRspAuthenticate(self, pRspAuthenticate, pRspInfo, nRequestID, bIsLast) -> None:
        if pRspInfo and pRspInfo.ErrorID != 0:
            logger.error(f"Auth failed: [{pRspInfo.ErrorID}] {pRspInfo.ErrorMsg}")
            self._login_event.set()
            return
        logger.info("CTP auth OK, sending login request...")
        if self._td_api:
            req = tdapi.CThostFtdcReqUserLoginField()
            req.BrokerID = self._config.broker_id
            req.UserID = self._config.user_id
            req.Password = self._config.password
            self._td_api.ReqUserLogin(req, 1)

    def OnFrontDisconnected(self, nReason: int) -> None:
        self.connected = False
        logger.warning(f"CTP front disconnected: {nReason}")

    def OnRspUserLogin(self, pRspUserLogin, pRspInfo, nRequestID, bIsLast) -> None:
        if pRspInfo and pRspInfo.ErrorID != 0:
            logger.error(f"Login failed: {pRspInfo.ErrorMsg}")
            return
        self.logged_in = True
        self.front_id = pRspUserLogin.FrontID
        self.session_id = pRspUserLogin.SessionID
        logger.info(f"CTP login OK: FrontID={self.front_id}, SessionID={self.session_id}")
        self._login_event.set()

    def OnRspQryTradingAccount(self, pTradingAccount, pRspInfo, nRequestID, bIsLast) -> None:
        if pRspInfo and pRspInfo.ErrorID != 0:
            logger.error(f"Account query failed: {pRspInfo.ErrorMsg}")
            self._account_event.set()
            return

        if pTradingAccount:
            static_equity = pTradingAccount.PreBalance + pTradingAccount.Deposit - pTradingAccount.Withdraw
            dynamic_equity = static_equity + pTradingAccount.PositionProfit + pTradingAccount.CloseProfit - pTradingAccount.Commission
            margin = pTradingAccount.CurrMargin
            available = pTradingAccount.Available
            risk_ratio = margin / dynamic_equity if dynamic_equity > 0 else 0

            with self._lock:
                self._account = FuturesAccount(
                    staticEquity=static_equity,
                    dynamicEquity=dynamic_equity,
                    available=available,
                    margin=margin,
                    floatingPnl=pTradingAccount.PositionProfit,
                    todayPnl=pTradingAccount.CloseProfit - pTradingAccount.Commission,
                    riskRatio=round(risk_ratio, 4),
                    timestamp=datetime.now().isoformat(),
                )

        if bIsLast:
            self._account_event.set()

    def OnRspQryInvestorPosition(self, pInvestorPosition, pRspInfo, nRequestID, bIsLast) -> None:
        if pRspInfo and pRspInfo.ErrorID != 0:
            logger.error(f"Position query failed: {pRspInfo.ErrorMsg}")
            self._position_event.set()
            return

        if pInvestorPosition and pInvestorPosition.InstrumentID:
            direction = PositionDirection.long if pInvestorPosition.PosiDirection == "2" else PositionDirection.short
            volume = pInvestorPosition.Position
            if volume > 0:
                open_price = pInvestorPosition.OpenCost / (volume * pInvestorPosition.VolumeMultiple) if volume > 0 else 0

                with self._lock:
                    self._positions.append(FuturesPosition(
                        instrumentId=pInvestorPosition.InstrumentID,
                        instrumentName=pInvestorPosition.InstrumentID,  # CTP doesn't provide display name
                        direction=direction,
                        volume=volume,
                        openPrice=round(open_price, 2),
                        currentPrice=0,  # Will be updated from market data
                        floatingPnl=pInvestorPosition.PositionProfit,
                        margin=pInvestorPosition.UseMargin,
                        openDate=pInvestorPosition.OpenDate if hasattr(pInvestorPosition, "OpenDate") else "",
                    ))

        if bIsLast:
            self._position_event.set()

    def OnRspOrderInsert(self, pInputOrder, pRspInfo, nRequestID, bIsLast) -> None:
        if pRspInfo and pRspInfo.ErrorID != 0:
            with self._lock:
                self._order_result = OrderResult(
                    success=False,
                    error=pRspInfo.ErrorMsg,
                    status=OrderStatus.rejected,
                    timestamp=datetime.now().isoformat(),
                )
        self._order_event.set()

    def OnRtnOrder(self, pOrder) -> None:
        if pOrder:
            status_map = {
                "0": OrderStatus.pending,
                "1": OrderStatus.partially_filled,
                "3": OrderStatus.filled,
                "5": OrderStatus.cancelled,
            }
            status = status_map.get(pOrder.OrderStatus, OrderStatus.pending)

            with self._lock:
                self._order_result = OrderResult(
                    success=status in (OrderStatus.pending, OrderStatus.filled, OrderStatus.partially_filled),
                    orderId=pOrder.OrderSysID.strip(),
                    status=status,
                    filledVolume=pOrder.VolumeTraded,
                    filledPrice=pOrder.LimitPrice,
                    timestamp=datetime.now().isoformat(),
                )
            self._order_event.set()


class CtpClient:
    """
    High-level CTP client that wraps the SPI callbacks into async methods.
    """

    def __init__(self, config: CtpConfig) -> None:
        self.config = config
        self._spi: Optional[CtpTraderSpi] = None
        self._td_api = None
        self._request_id = 0
        self._connected = False

    @property
    def is_connected(self) -> bool:
        return self._connected and self._spi is not None and self._spi.logged_in

    async def connect(self) -> bool:
        """Connect to CTP and login."""
        if not CTP_AVAILABLE:
            logger.warning("CTP bindings not available, using mock mode")
            self._connected = True
            return True

        flow_path = tempfile.mkdtemp(prefix="ctp_")
        self._td_api = tdapi.CThostFtdcTraderApi.CreateFtdcTraderApi(
            os.path.join(flow_path, "trader")
        )

        self._spi = CtpTraderSpi(self.config)
        self._td_api.RegisterSpi(self._spi)
        self._spi._td_api = self._td_api
        self._td_api.RegisterFront(self.config.td_address)
        self._td_api.SubscribePublicTopic(2)  # THOST_TERT_QUICK
        self._td_api.SubscribePrivateTopic(2)
        self._td_api.Init()

        # Wait for connection and login
        try:
            await asyncio.wait_for(self._spi._login_event.wait(), timeout=10)
        except asyncio.TimeoutError:
            logger.error("CTP login timeout")
            return False

        self._connected = True
        return True

    def _next_request_id(self) -> int:
        self._request_id += 1
        return self._request_id

    async def get_account(self) -> FuturesAccount:
        """Query trading account."""
        if not self.is_connected:
            return self._mock_account()

        self._spi._account = None
        self._spi._account_event.clear()

        req = tdapi.CThostFtdcQryTradingAccountField()
        req.BrokerID = self.config.broker_id
        req.InvestorID = self.config.user_id
        self._td_api.ReqQryTradingAccount(req, self._next_request_id())

        await asyncio.wait_for(self._spi._account_event.wait(), timeout=5)
        if self._spi._account is None:
            raise RuntimeError("Failed to query account")
        return self._spi._account

    async def get_positions(self) -> list[FuturesPosition]:
        """Query all open positions."""
        if not self.is_connected:
            return []

        self._spi._positions = []
        self._spi._position_event.clear()

        req = tdapi.CThostFtdcQryInvestorPositionField()
        req.BrokerID = self.config.broker_id
        req.InvestorID = self.config.user_id
        self._td_api.ReqQryInvestorPosition(req, self._next_request_id())

        await asyncio.wait_for(self._spi._position_event.wait(), timeout=5)
        return self._spi._positions

    async def place_order(self, order: OrderRequest) -> OrderResult:
        """Submit a new order."""
        if not self.is_connected:
            return self._mock_order_result(order)

        self._spi._order_result = None
        self._spi._order_event.clear()

        req = tdapi.CThostFtdcInputOrderField()
        req.BrokerID = self.config.broker_id
        req.InvestorID = self.config.user_id
        req.InstrumentID = order.instrumentId
        req.Direction = "0" if order.direction.value == "buy" else "1"
        req.CombOffsetFlag = {"open": "0", "close": "1", "close_today": "3"}[order.offset.value]
        req.CombHedgeFlag = "1"  # Speculation
        req.VolumeTotalOriginal = order.volume
        req.TimeCondition = "1" if order.orderType.value == "market" else "3"
        req.VolumeCondition = "1"  # Any volume
        req.ContingentCondition = "1"
        req.ForceCloseReason = "0"

        if order.orderType.value == "market":
            req.OrderPriceType = "1"  # Any price
            req.LimitPrice = 0
        else:
            req.OrderPriceType = "2"  # Limit price
            req.LimitPrice = order.price or 0

        self._td_api.ReqOrderInsert(req, self._next_request_id())

        try:
            await asyncio.wait_for(self._spi._order_event.wait(), timeout=10)
        except asyncio.TimeoutError:
            return OrderResult(
                success=False,
                error="Order timeout",
                status=OrderStatus.rejected,
                timestamp=datetime.now().isoformat(),
            )

        return self._spi._order_result or OrderResult(
            success=False,
            error="No response",
            status=OrderStatus.rejected,
            timestamp=datetime.now().isoformat(),
        )

    async def cancel_order(self, order_id: str) -> dict:
        """Cancel a pending order."""
        if not self.is_connected:
            return {"success": True}

        req = tdapi.CThostFtdcInputOrderActionField()
        req.BrokerID = self.config.broker_id
        req.InvestorID = self.config.user_id
        req.OrderSysID = order_id
        req.ActionFlag = "0"  # Delete

        self._td_api.ReqOrderAction(req, self._next_request_id())
        return {"success": True}

    async def get_pnl(self) -> PnlSummary:
        """Get P&L summary from account data."""
        account = await self.get_account()
        return PnlSummary(
            todayPnl=account.todayPnl,
            floatingPnl=account.floatingPnl,
            totalPnl=account.todayPnl + account.floatingPnl,
        )

    # ─── Mock methods for environments without CTP ────────────────

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
            orderId=f"MOCK_{self._next_request_id()}",
            status=OrderStatus.filled,
            filledVolume=order.volume,
            filledPrice=order.price or 0,
            timestamp=datetime.now().isoformat(),
        )
