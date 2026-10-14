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
DIAMOND_TO_USD_RATE: float = 0.005   # 1 diamond ≈ $0.005 gross creator earnings
NET_PAYOUT_RATIO:    float = 0.50    # TikTok pays ~50% of gross to creator

# WebSocket heartbeat interval (seconds)
WS_HEARTBEAT_INTERVAL: float = 15.0

# Maximum concurrent tracking sessions
MAX_SESSIONS: int = int(os.getenv("MAX_SESSIONS", "100"))

# Re-connection retry attempts on disconnect
RECONNECT_ATTEMPTS: int = 3

# Optional EulerStream Sign API Key for high-concurrency TikTok Webcast signing
SIGN_API_KEY: str = os.getenv("SIGN_API_KEY", "")
