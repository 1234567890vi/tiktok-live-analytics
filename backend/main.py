# =============================================================================
#  backend/main.py — FastAPI application entry point.
#  Serves the static frontend and provides the WebSocket /ws/track/{username}.
# =============================================================================

from __future__ import annotations

import asyncio
import json
import logging
import time
import hmac
import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from backend.config import (
    FRONTEND_DIR,
    WS_HEARTBEAT_INTERVAL,
    MAX_SESSIONS,
)
from backend.tiktok_listener import TikTokSession

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("tiktok_tracker")

# ---------------------------------------------------------------------------
# Admin & Analytics Tracking Registry
# ---------------------------------------------------------------------------
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")
_server_start_time = time.time()
_total_connections = 0
_admin_tokens: set[str] = set()
_search_history: list[dict] = []

# ---------------------------------------------------------------------------
# Session registry — created inside the lifespan so it has a running event loop
# ---------------------------------------------------------------------------
_active_sessions: dict[str, TikTokSession] = {}
_sessions_lock: asyncio.Lock | None = None   # initialised in lifespan


def _get_lock() -> asyncio.Lock:
    """Return the sessions lock; raises if called before app startup."""
    if _sessions_lock is None:
        raise RuntimeError("Session lock not initialised — app not started yet.")
    return _sessions_lock


# ---------------------------------------------------------------------------
# Lifespan — replaces deprecated @app.on_event("startup/shutdown")
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _sessions_lock
    _sessions_lock = asyncio.Lock()   # created in running event loop ✓

    logger.info("🚀 TikTok Live Analytics Tracker starting up...")
    logger.info("   Frontend: %s", FRONTEND_DIR)
    logger.info("   Max sessions: %d", MAX_SESSIONS)

    yield  # ── app runs here ────────────────────────────────────────────

    logger.info("🛑 Shutting down — stopping all active sessions...")
    async with _sessions_lock:
        tasks = [session.stop() for session in _active_sessions.values()]
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    logger.info("All sessions stopped.")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(
    title="TikTok Live Analytics Tracker",
    description="Real-time TikTok Live stream analytics powered by a C++ core engine.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Static files — serve frontend/
# ---------------------------------------------------------------------------
if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")
else:
    logger.warning("Frontend directory not found at %s", FRONTEND_DIR)


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------

@app.get("/", response_class=FileResponse)
async def serve_index():
    """Serve the main dashboard HTML."""
    index_path = FRONTEND_DIR / "index.html"
    if not index_path.exists():
        return HTMLResponse(
            "<h1>Frontend not found</h1>"
            "<p>Place index.html inside the <code>frontend/</code> directory.</p>",
            status_code=404,
        )
    return FileResponse(str(index_path), media_type="text/html")


@app.get("/health")
async def health_check():
    """Liveness / readiness probe for cloud deployment health checks."""
    return {
        "status":          "ok",
        "active_sessions": len(_active_sessions),
        "max_sessions":    MAX_SESSIONS,
    }


@app.get("/sessions")
async def list_sessions():
    """Return a list of currently tracked usernames."""
    return {"sessions": list(_active_sessions.keys())}


# ---------------------------------------------------------------------------
# Admin API endpoints
# ---------------------------------------------------------------------------

@app.post("/api/admin/login")
async def admin_login(data: dict):
    """Authenticate admin and issue a secure session token."""
    pwd = str(data.get("password", "")).strip()
    if hmac.compare_digest(pwd, ADMIN_PASSWORD):
        token = secrets.token_hex(24)
        _admin_tokens.add(token)
        return {"status": "ok", "token": token}
    return JSONResponse(status_code=401, content={"status": "error", "message": "Invalid password"})


@app.get("/api/admin/stats")
async def admin_stats(request: Request, token: str = ""):
    """Return administrative analytics: active users, total visits, searched targets & durations."""
    auth_hdr = request.headers.get("authorization", "")
    tok = token or (auth_hdr.replace("Bearer ", "").strip() if "Bearer " in auth_hdr else "")
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})

    uptime = int(time.time() - _server_start_time)
    now = int(time.time())
    history_copy = []
    for item in _search_history[:50]:
        row = dict(item)
        if row["status"] == "active":
            row["duration_seconds"] = max(0, now - row["started_at"])
            sess = _active_sessions.get(row["username"])
            if sess:
                row["total_diamonds"] = getattr(sess._engine, "get_total_diamonds", lambda: 0)()
        history_copy.append(row)

    return {
        "status": "ok",
        "server_uptime_seconds": uptime,
        "total_connections": _total_connections,
        "active_users_count": len(_active_sessions),
        "active_sessions": list(_active_sessions.keys()),
        "search_history": history_copy,
    }


@app.post("/api/admin/logout")
async def admin_logout(data: dict):
    """Revoke admin session token."""
    token = data.get("token", "")
    _admin_tokens.discard(token)
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# WebSocket — /ws/track/{username}
# ---------------------------------------------------------------------------

@app.websocket("/ws/track/{username}")
async def ws_track(websocket: WebSocket, username: str):
    """
    WebSocket endpoint that tracks a TikTok Live room.

    Server → Client messages:
      { "type": "connecting",   "username": "..." }
      { "type": "connected",    "username": "...", "room_id": "..." }
      { "type": "disconnected", "username": "..." }
      { "type": "error",        "message": "...", "detail": "..." }
      { "type": "snapshot",     "data": { ...DashboardSnapshot... } }
      { "type": "comment",      "data": { ...CommentItem... } }
      { "type": "like",         "data": { ...LikePayload... } }
      { "type": "gift",         "data": { ... }, "leaderboard": [...] }
      { "type": "pk_battle",    "data": { ...PKRoundState... }, "event": "start|update|ended" }
      { "type": "viewers",      "data": { "viewer_count": N } }
      { "type": "heartbeat",    "ts": 1234567890 }

    Client → Server messages:
      { "action": "disconnect" }  — stop tracking
      { "action": "snapshot"   }  — request an immediate snapshot
    """
    await websocket.accept()
    clean_username = username.lstrip("@").strip()

    if not clean_username:
        await websocket.send_text(json.dumps({
            "type":    "error",
            "message": "Invalid username",
            "detail":  "Username cannot be empty.",
        }))
        await websocket.close()
        return

    lock = _get_lock()

    async with lock:
        if len(_active_sessions) >= MAX_SESSIONS:
            await websocket.send_text(json.dumps({
                "type":    "error",
                "message": "Server at capacity",
                "detail":  f"Maximum of {MAX_SESSIONS} concurrent sessions reached.",
            }))
            await websocket.close()
            return

        # If a session already exists for this username (e.g. page refresh), stop it first
        if clean_username in _active_sessions:
            old = _active_sessions.pop(clean_username)
            await old.stop()

    # Track search history & connection count
    global _total_connections
    _total_connections += 1

    session_record = {
        "id": secrets.token_hex(4),
        "username": clean_username,
        "started_at": int(time.time()),
        "ended_at": None,
        "duration_seconds": 0,
        "total_diamonds": 0,
        "status": "active",
    }
    _search_history.insert(0, session_record)
    if len(_search_history) > 100:
        _search_history.pop()

    # ---- Broadcast function (called from TikTokSession event handlers) ----
    async def broadcast(payload: dict) -> None:
        try:
            await websocket.send_text(json.dumps(payload, default=str))
        except Exception:
            pass  # WebSocket may have closed; TikTokSession handles cleanup

    # ---- Create and register session ----
    session = TikTokSession(clean_username, broadcast)
    async with lock:
        _active_sessions[clean_username] = session

    logger.info("Starting session for @%s", clean_username)

    await websocket.send_text(json.dumps({
        "type":     "connecting",
        "username": clean_username,
        "message":  f"Connecting to @{clean_username}...",
    }))

    await session.start()

    # ---- Heartbeat + client message loop ----
    try:
        while True:
            try:
                raw = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=WS_HEARTBEAT_INTERVAL,
                )
                msg    = json.loads(raw)
                action = msg.get("action", "")

                if action == "disconnect":
                    logger.info("Client requested disconnect for @%s", clean_username)
                    break
                elif action == "snapshot":
                    await session.send_snapshot()
                else:
                    logger.debug("Unknown client action: %s", action)

            except asyncio.TimeoutError:
                # Send heartbeat ping & periodic snapshot
                await websocket.send_text(json.dumps({
                    "type": "heartbeat",
                    "ts":   int(time.time()),
                }))
                await session.send_snapshot()

            # Break out if the background TikTok task died
            if not session._running and (
                session._task is None or session._task.done()
            ):
                break

    except (WebSocketDisconnect, Exception) as exc:
        logger.info("WebSocket closed for @%s (%s)", clean_username, type(exc).__name__)
    finally:
        session_record["ended_at"] = int(time.time())
        session_record["duration_seconds"] = max(0, session_record["ended_at"] - session_record["started_at"])
        session_record["total_diamonds"] = getattr(session._engine, "get_total_diamonds", lambda: 0)()
        session_record["status"] = "completed"

        async with lock:
            _active_sessions.pop(clean_username, None)
        await session.stop()
        logger.info("Session cleaned up for @%s", clean_username)


# ---------------------------------------------------------------------------
# Dev entrypoint
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    from backend.config import HOST, PORT

    uvicorn.run(
        "backend.main:app",
        host=HOST,
        port=PORT,
        reload=False,
        log_level="info",
    )
