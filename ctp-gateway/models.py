"""
Pydantic models matching the TypeScript FuturesAccount/Position/Order types.
"""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel


# ─── Account ────────────────────────────────────────────────────


class FuturesAccount(BaseModel):
    staticEquity: float
    dynamicEquity: float
    available: float
    margin: float
    floatingPnl: float
    todayPnl: float
    riskRatio: float
    timestamp: str


# ─── Positions ──────────────────────────────────────────────────


class PositionDirection(str, Enum):
    long = "long"
    short = "short"


class FuturesPosition(BaseModel):
    instrumentId: str
    instrumentName: str
    direction: PositionDirection
    volume: int
    openPrice: float
    currentPrice: float
    floatingPnl: float
    margin: float
    openDate: str


# ─── Orders ─────────────────────────────────────────────────────


class OrderDirection(str, Enum):
    buy = "buy"
    sell = "sell"


class OrderType(str, Enum):
    market = "market"
    limit = "limit"


class OffsetFlag(str, Enum):
    open = "open"
    close = "close"
    close_today = "close_today"


class OrderStatus(str, Enum):
    pending = "pending"
    partially_filled = "partially_filled"
    filled = "filled"
    cancelled = "cancelled"
    rejected = "rejected"


class OrderRequest(BaseModel):
    instrumentId: str
    direction: OrderDirection
    orderType: OrderType
    offset: OffsetFlag
    volume: int
    price: Optional[float] = None
    stopLoss: Optional[float] = None
    takeProfit: Optional[float] = None


class OrderResult(BaseModel):
    success: bool
    orderId: Optional[str] = None
    error: Optional[str] = None
    status: OrderStatus
    filledVolume: int = 0
    filledPrice: float = 0.0
    timestamp: str = ""


# ─── Market Data ────────────────────────────────────────────────


class MarketSnapshot(BaseModel):
    instrumentId: str
    lastPrice: float
    bidPrice: float
    bidVolume: int
    askPrice: float
    askVolume: int
    openPrice: float
    highPrice: float
    lowPrice: float
    preClosePrice: float
    upperLimit: float
    lowerLimit: float
    volume: int
    turnover: float
    openInterest: float
    timestamp: str


class PnlSummary(BaseModel):
    todayPnl: float
    floatingPnl: float
    totalPnl: float


class ClosePositionRequest(BaseModel):
    direction: PositionDirection
    volume: Optional[int] = None
