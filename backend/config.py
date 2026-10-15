# =============================================================================
#  backend/config.py — centralised configuration for the TikTok Live Tracker.
# =============================================================================

import os
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
BASE_DIR     = Path(__file__).parent.parent.resolve()
FRONTEND_DIR = BASE_DIR / "frontend"

# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

# ---------------------------------------------------------------------------
# TikTok / Revenue
# ---------------------------------------------------------------------------
# Gross supporter coins value: 1 diamond / coin ≈ $0.010 USD
GROSS_DIAMOND_USD_RATE: float = 0.010
DIAMOND_TO_USD_RATE:    float = 0.010   # Backward compatibility alias

# Net creator payout: TikTok's official cashout policy is 200 Diamonds = $1.00 USD
# Take-home rate = $1.00 / 200 = $0.0050 USD per diamond (50% of gross coin value)
NET_DIAMOND_USD_RATE:   float = 0.0050
NET_PAYOUT_RATIO:       float = 0.50    # Net payout = estimated_usd * 0.50 ($0.005/diamond)

# WebSocket heartbeat interval (seconds)
WS_HEARTBEAT_INTERVAL: float = 15.0

# Maximum concurrent tracking sessions
MAX_SESSIONS: int = int(os.getenv("MAX_SESSIONS", "100"))

# Re-connection retry attempts on disconnect
RECONNECT_ATTEMPTS: int = 3

# Optional EulerStream Sign API Key for high-concurrency TikTok Webcast signing
SIGN_API_KEY: str = os.getenv("SIGN_API_KEY", "")
