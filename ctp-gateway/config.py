"""
Gateway Configuration

Supports TqSdk with TqSim (simulator) or live account.
"""

from pydantic import BaseModel


class TqConfig(BaseModel):
    """TqSdk connection configuration."""

    # TqAuth credentials (phone number + password)
    user_id: str = ""
    password: str = ""

    # Gateway settings
    host: str = "127.0.0.1"
    port: int = 8400

    # Use TqSim simulator (vs real broker)
    use_sim: bool = True
    initial_balance: float = 10_000_000  # TqSim starting capital (CNY)

    # Instruments to subscribe on startup (optional)
    # e.g., ["SHFE.rb2510", "DCE.m2509", "CZCE.MA509"]
    default_instruments: list[str] = []
