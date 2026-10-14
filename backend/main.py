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
import re
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from backend.config import (
    FRONTEND_DIR,
    WS_HEARTBEAT_INTERVAL,
    MAX_SESSIONS,
)
from backend.tiktok_listener import TikTokSession
from backend.telegram_bot import TelegramBotManager

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
_banned_targets: set[str] = set()
_tracking_enabled: bool = True
_active_websockets: dict[str, set[WebSocket]] = {}


def _get_admin_token(request: Request, data: dict | None = None) -> str:
    """Extract admin token from header, body, or query param."""
    auth_hdr = request.headers.get("authorization", "")
    if "Bearer " in auth_hdr:
        return auth_hdr.replace("Bearer ", "").strip()
    if data and isinstance(data, dict) and "token" in data:
        return str(data["token"]).strip()
    return request.query_params.get("token", "").strip()


def _get_current_stats() -> dict:
    """Helper returning real-time statistical snapshot of users, sessions, and history."""
    uptime = int(time.time() - _server_start_time)
    now = int(time.time())
    history_copy = []
    for item in _search_history[:80]:
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
        "active_users_count": sum(len(s) for s in _active_websockets.values()),
        "active_streamers_count": len(_active_sessions),
        "active_sessions": list(_active_sessions.keys()),
        "search_history": history_copy,
        "tracking_enabled": _tracking_enabled,
        "banned_targets": sorted(list(_banned_targets)),
    }


# Telegram Bot & Notification Service
telegram_bot = TelegramBotManager(stats_provider=_get_current_stats)


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

    await telegram_bot.start()

    yield  # ── app runs here ────────────────────────────────────────────

    logger.info("🛑 Shutting down — stopping all active sessions...")
    await telegram_bot.stop()
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


@app.get("/admin", response_class=FileResponse)
async def serve_admin_page():
    """Direct route for the owner to access admin control panel."""
    admin_path = FRONTEND_DIR / "admin.html"
    if not admin_path.exists():
        return HTMLResponse(
            "<h1>Admin page not found</h1>"
            "<p>Place admin.html inside the <code>frontend/</code> directory.</p>",
            status_code=404,
        )
    return FileResponse(str(admin_path), media_type="text/html")


@app.get("/health")
async def health_check():
    """Liveness / readiness probe for cloud deployment health checks."""
    return {
        "status":          "ok",
        "active_sessions": len(_active_sessions),
        "max_sessions":    MAX_SESSIONS,
        "tracking_enabled": _tracking_enabled,
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
    tok = _get_admin_token(request, {"token": token})
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})

    data = _get_current_stats()
    current_sign_key = os.getenv("SIGN_API_KEY", "")
    masked_key = (current_sign_key[:4] + "..." + current_sign_key[-4:]) if len(current_sign_key) >= 8 else ("***" if current_sign_key else "")
    data["has_sign_api_key"] = bool(current_sign_key)
    data["sign_api_key_masked"] = masked_key
    data["telegram"] = telegram_bot.get_safe_config()
    return data


@app.get("/api/admin/telegram/settings")
async def admin_telegram_get_settings(request: Request):
    """Return current Telegram bot configuration."""
    tok = _get_admin_token(request)
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})
    return {"status": "ok", "settings": telegram_bot.get_safe_config()}


@app.post("/api/admin/telegram/save")
async def admin_telegram_save_settings(request: Request, data: dict):
    """Save Telegram bot settings and restart polling service."""
    tok = _get_admin_token(request, data)
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})

    telegram_bot.save_config(data)
    await telegram_bot.restart()
    return {
        "status": "ok",
        "settings": telegram_bot.get_safe_config(),
        "message": "تم حفظ إعدادات تلغرام وتفعيل الخدمة بنجاح",
    }


@app.post("/api/admin/telegram/test")
async def admin_telegram_test(request: Request, data: dict):
    """Send test message to Telegram bot."""
    tok = _get_admin_token(request, data)
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})

    success, msg = await telegram_bot.send_test_message()
    if success:
        return {"status": "ok", "message": msg}
    return JSONResponse(status_code=400, content={"status": "error", "message": msg})


@app.post("/api/admin/telegram/send-report")
async def admin_telegram_send_report(request: Request, data: dict):
    """Force sending current stats report to Telegram immediately."""
    tok = _get_admin_token(request, data)
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})

    success, msg = await telegram_bot.send_stats_report()
    if success:
        return {"status": "ok", "message": "تم إرسال التقرير الإحصائي إلى تلغرام بنجاح"}
    return JSONResponse(status_code=400, content={"status": "error", "message": msg})


@app.post("/api/admin/set-sign-key")
async def admin_set_sign_key(request: Request, data: dict):
    """Set or update EulerStream SIGN_API_KEY dynamically."""
    tok = _get_admin_token(request, data)
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})

    new_key = str(data.get("sign_api_key", "")).strip()
    os.environ["SIGN_API_KEY"] = new_key
    try:
        from TikTokLive.client.web.web_settings import WebDefaults
        WebDefaults.tiktok_sign_api_key = new_key if new_key else None
    except Exception as e:
        logger.warning("Could not set WebDefaults sign key: %s", e)

    logger.info("Admin updated EulerStream SIGN_API_KEY (has_key=%s)", bool(new_key))
    return {"status": "ok", "has_sign_api_key": bool(new_key)}


@app.post("/api/admin/kick")
async def admin_kick(request: Request, data: dict):
    """Forcefully disconnect / kick an active tracking session."""
    tok = _get_admin_token(request, data)
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})

    target = str(data.get("username", "")).lstrip("@").strip()
    if not target:
        return JSONResponse(status_code=400, content={"status": "error", "message": "Username required"})

    logger.warning("Admin kicking session for target @%s", target)

    # Disconnect client WebSockets
    sockets = list(_active_websockets.get(target, set()))
    for ws in sockets:
        try:
            await ws.send_text(json.dumps({
                "type": "error",
                "message": "Session Terminated",
                "detail": "تم إنهاء جلسة التتبع وإيقافها بواسطة إدارة الموقع.",
            }))
            await ws.close(code=1008, reason="Terminated by admin")
        except Exception:
            pass

    # Stop background session
    lock = _get_lock()
    async with lock:
        sess = _active_sessions.pop(target, None)
    if sess:
        await sess.stop()

    # Update history status
    now = int(time.time())
    for record in _search_history:
        if record["username"] == target and record["status"] == "active":
            record["status"] = "kicked"
            record["ended_at"] = now
            record["duration_seconds"] = max(0, now - record["started_at"])

    return {"status": "ok", "message": f"Kicked session for @{target}"}


@app.post("/api/admin/ban")
async def admin_ban(request: Request, data: dict):
    """Ban a target account from being tracked on the platform."""
    tok = _get_admin_token(request, data)
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})

    target = str(data.get("username", "")).lstrip("@").strip()
    if not target:
        return JSONResponse(status_code=400, content={"status": "error", "message": "Username required"})

    _banned_targets.add(target)
    logger.warning("Admin banned target @%s", target)

    # If currently active, immediately kick it
    sockets = list(_active_websockets.get(target, set()))
    for ws in sockets:
        try:
            await ws.send_text(json.dumps({
                "type": "error",
                "message": "Account Banned",
                "detail": f"تم حظر حساب @{target} من التتبع بواسطة الأدمن.",
            }))
            await ws.close(code=1008, reason="Banned by admin")
        except Exception:
            pass

    lock = _get_lock()
    async with lock:
        sess = _active_sessions.pop(target, None)
    if sess:
        await sess.stop()

    now = int(time.time())
    for record in _search_history:
        if record["username"] == target and record["status"] == "active":
            record["status"] = "banned"
            record["ended_at"] = now
            record["duration_seconds"] = max(0, now - record["started_at"])

    return {"status": "ok", "banned_targets": sorted(list(_banned_targets))}


@app.post("/api/admin/unban")
async def admin_unban(request: Request, data: dict):
    """Remove a target account from the banned list."""
    tok = _get_admin_token(request, data)
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})

    target = str(data.get("username", "")).lstrip("@").strip()
    _banned_targets.discard(target)
    logger.info("Admin unbanned target @%s", target)
    return {"status": "ok", "banned_targets": sorted(list(_banned_targets))}


@app.post("/api/admin/toggle-tracking")
async def admin_toggle_tracking(request: Request, data: dict):
    """Enable or disable global tracking (maintenance mode / freeze)."""
    tok = _get_admin_token(request, data)
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})

    global _tracking_enabled
    _tracking_enabled = bool(data.get("enabled", True))
    logger.warning("Admin changed tracking_enabled to %s", _tracking_enabled)
    return {"status": "ok", "tracking_enabled": _tracking_enabled}


@app.post("/api/admin/broadcast")
async def admin_broadcast(request: Request, data: dict):
    """Send an instant announcement toast to all active users."""
    tok = _get_admin_token(request, data)
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})

    msg = str(data.get("message", "")).strip()
    if not msg:
        return JSONResponse(status_code=400, content={"status": "error", "message": "Message required"})

    count = 0
    payload = json.dumps({
        "type": "admin_announcement",
        "message": msg,
    })
    for ws_set in _active_websockets.values():
        for ws in list(ws_set):
            try:
                await ws.send_text(payload)
                count += 1
            except Exception:
                pass

    return {"status": "ok", "recipients_count": count}


@app.post("/api/admin/clear-history")
async def admin_clear_history(request: Request, data: dict):
    """Clear completed search history records."""
    tok = _get_admin_token(request, data)
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})

    global _search_history
    _search_history = [r for r in _search_history if r.get("status") == "active"]
    return {"status": "ok", "message": "Completed history cleared"}


@app.post("/api/admin/logout")
async def admin_logout(data: dict):
    """Revoke admin session token."""
    token = data.get("token", "")
    _admin_tokens.discard(token)
    return {"status": "ok"}


@app.get("/api/stream_proxy")
async def stream_proxy(url: str):
    """
    Reverse proxy for live video stream playlists (.m3u8) and video segments (.ts)
    to bypass browser CORS restrictions and allow in-browser live video playback.
    """
    if not url or not (url.startswith("http://") or url.startswith("https://")):
        return JSONResponse(status_code=400, content={"error": "Invalid stream URL"})

    from urllib.parse import urljoin, quote

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://www.tiktok.com/",
    }

    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True, headers=headers) as client:
            resp = await client.get(url)

            # Check if this is an HLS playlist
            is_playlist = ".m3u8" in url or "mpegurl" in (resp.headers.get("content-type") or "")
            if is_playlist and resp.status_code == 200:
                text = resp.text
                lines = []
                for line in text.splitlines():
                    stripped = line.strip()
                    if stripped and not stripped.startswith("#"):
                        # Relative or absolute segment/variant URL
                        full_url = urljoin(url, stripped)
                        proxied_url = f"/api/stream_proxy?url={quote(full_url)}"
                        lines.append(proxied_url)
                    else:
                        lines.append(line)

                rewritten = "\n".join(lines)
                return Response(
                    content=rewritten,
                    media_type="application/vnd.apple.mpegurl",
                    headers={
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                        "Cache-Control": "no-cache, no-store, must-revalidate",
                    }
                )

            # Direct binary streaming for video chunks (.ts) or other formats
            media_type = resp.headers.get("content-type") or "video/mp2t"
            return Response(
                content=resp.content,
                status_code=resp.status_code,
                media_type=media_type,
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                }
            )
    except Exception as exc:
        logger.debug("stream_proxy error: %s", exc)
        return JSONResponse(status_code=502, content={"error": "Proxy error", "detail": str(exc)})


# ---------------------------------------------------------------------------
# WebSocket — /ws/track/{username}
# ---------------------------------------------------------------------------

def clean_tiktok_username(raw: str) -> str:
    """Sanitize and extract TikTok username from handle, URL, or pasted text."""
    if not raw:
        return ""
    # URL-decode in case it was encoded by browser in WebSocket path
    from urllib.parse import unquote
    s = unquote(str(raw))
    # Strip directional unicode formatting marks and non-printable chars
    s = re.sub(r"[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]", "", s).strip()
    # Check if full URL e.g. tiktok.com/@username/live or /@username
    url_match = re.search(r"tiktok\.com/@([a-zA-Z0-9_.-]+)", s, re.IGNORECASE)
    if url_match:
        return url_match.group(1).rstrip("/")
    # Remove leading @ and any trailing path or query
    s = s.lstrip("@").split("?")[0].split("/")[0].strip()
    return s


@app.websocket("/ws/track/{username:path}")
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
    clean_username = clean_tiktok_username(username)

    if not clean_username:
        await websocket.send_text(json.dumps({
            "type":    "error",
            "message": "اسم المستخدم غير صالح",
            "detail":  "يرجى إدخال اسم مستخدم صالح أو رابط البث المباشر لحساب تيك توك.",
        }))
        await websocket.close()
        return

    # Check if user accidentally entered Arabic characters (display name instead of handle)
    if re.search(r"[\u0600-\u06FF]", clean_username):
        await websocket.send_text(json.dumps({
            "type":    "error",
            "message": "اسم المستخدم يجب أن يكون بالإنجليزية",
            "detail":  "يرجى إدخال اسم المعرّف الإنجليزي (@username المكتوب تحت الصورة الشخصية، مثل kingmauritan) وليس الاسم المعروض بالعربية.",
        }))
        await websocket.close()
        return

    if not _tracking_enabled:
        await websocket.send_text(json.dumps({
            "type":    "error",
            "message": "Tracking Disabled",
            "detail":  "خدمة التتبع معطلة مؤقتاً للصيانة بواسطة إدارة الموقع.",
        }))
        await websocket.close()
        return

    if clean_username in _banned_targets:
        await websocket.send_text(json.dumps({
            "type":    "error",
            "message": "Target Banned",
            "detail":  f"الحساب @{clean_username} محظور من التتبع بواسطة الأدمن.",
        }))
        await websocket.close()
        return

    lock = _get_lock()

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

    session: TikTokSession | None = None
    is_session_creator = False

    async with lock:
        # Check if a session is already active for this streamer
        if clean_username in _active_sessions:
            session = _active_sessions[clean_username]
        else:
            if len(_active_sessions) >= MAX_SESSIONS:
                await websocket.send_text(json.dumps({
                    "type":    "error",
                    "message": "Server at capacity",
                    "detail":  f"Maximum of {MAX_SESSIONS} concurrent streamer sessions reached.",
                }))
                await websocket.close()
                return

            # Broadcast fan-out coroutine to all subscribed WebSockets for this streamer
            async def broadcast(payload: dict) -> None:
                sockets = list(_active_websockets.get(clean_username, set()))
                if not sockets:
                    return
                data_str = json.dumps(payload, default=str)

                async def _send_one(ws: WebSocket):
                    try:
                        await ws.send_text(data_str)
                    except Exception:
                        _active_websockets.get(clean_username, set()).discard(ws)

                await asyncio.gather(*[_send_one(ws) for ws in sockets], return_exceptions=True)

            session = TikTokSession(clean_username, broadcast)
            _active_sessions[clean_username] = session
            is_session_creator = True

    # Register this client's WebSocket for the target streamer
    _active_websockets.setdefault(clean_username, set()).add(websocket)

    if is_session_creator:
        logger.info("Starting new background TikTok session for @%s (first viewer)", clean_username)
        await websocket.send_text(json.dumps({
            "type":     "connecting",
            "username": clean_username,
            "message":  f"Connecting to @{clean_username}...",
        }))
        await session.start()
        asyncio.create_task(telegram_bot.notify_stream_started(clean_username, 1))
    else:
        logger.info(
            "Client connected to existing active session for @%s (viewers: %d)",
            clean_username,
            len(_active_websockets.get(clean_username, set()))
        )
        # If the session is already fully connected to TikTok, notify client immediately
        if session._is_connected or getattr(session, "is_connected", False):
            await websocket.send_text(json.dumps({
                "type":     "connected",
                "username": clean_username,
                "room_id":  session.room_id or "live",
            }))
        else:
            await websocket.send_text(json.dumps({
                "type":     "connecting",
                "username": clean_username,
                "message":  f"Connecting to @{clean_username}...",
            }))
        # Send instant snapshot of current stream metrics
        try:
            await websocket.send_text(json.dumps(session.get_snapshot_payload(), default=str))
        except Exception:
            pass

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
                    await websocket.send_text(json.dumps(session.get_snapshot_payload(), default=str))
                else:
                    logger.debug("Unknown client action: %s", action)

            except asyncio.TimeoutError:
                # Send heartbeat ping & periodic snapshot directly to this client
                await websocket.send_text(json.dumps({
                    "type": "heartbeat",
                    "ts":   int(time.time()),
                }))
                if session._running:
                    await websocket.send_text(json.dumps(session.get_snapshot_payload(), default=str))

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

        # Remove this specific websocket from the room's subscriber set
        if clean_username in _active_websockets:
            _active_websockets[clean_username].discard(websocket)
            remaining_viewers = len(_active_websockets[clean_username])
            if remaining_viewers == 0:
                _active_websockets.pop(clean_username, None)
                # No more clients watching this streamer — shut down the TikTok session
                async with lock:
                    # Double-check if another client joined before popping
                    if not _active_websockets.get(clean_username):
                        ended_session = _active_sessions.pop(clean_username, None)
                        if ended_session:
                            await ended_session.stop()
                            logger.info("Session cleaned up for @%s (0 active viewers)", clean_username)
                            asyncio.create_task(telegram_bot.notify_stream_ended(
                                clean_username,
                                session_record["duration_seconds"],
                                session_record["total_diamonds"],
                            ))
            else:
                logger.info("Client disconnected from @%s (%d viewers still watching)", clean_username, remaining_viewers)


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
