"""
CTP Gateway Configuration

Supports SimNow and OpenCTP TTS environments.
"""

from pydantic import BaseModel


class CtpConfig(BaseModel):
    """CTP connection configuration."""

    # Broker and user credentials
    broker_id: str = "9999"  # SimNow default
    user_id: str = ""
    password: str = ""
    app_id: str = "simnow_client_test"
    auth_code: str = "0000000000000000"

    # Server addresses
    # SimNow 7x24: trade=180.168.146.187:10130, md=180.168.146.187:10131
    # OpenCTP TTS: see https://github.com/openctp/openctp for latest addresses
    td_address: str = "tcp://180.168.146.187:10130"
    md_address: str = "tcp://180.168.146.187:10131"

    # Gateway settings
    host: str = "127.0.0.1"
    port: int = 8400

    # Use OpenCTP TTS instead of SimNow
    use_openctp: bool = True


# OpenCTP TTS addresses (7x24 available)
OPENCTP_TTS_ADDRESSES = {
    "7x24": {
        "td": "tcp://121.37.80.177:20002",
        "md": "tcp://121.37.80.177:20004",
    },
    "sim": {
        "td": "tcp://121.37.80.177:20002",
        "md": "tcp://121.37.80.177:20004",
    },
}
