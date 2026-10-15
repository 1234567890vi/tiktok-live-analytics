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
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit
import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from backend.config import (
    BASE_DIR,
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
_session_cleanup_tasks: dict[str, asyncio.Task] = {}
SESSION_GRACE_PERIOD_SECONDS = 600  # 10 minutes grace period for background tracking during navigation

# ---------------------------------------------------------------------------
# Viewer Feature Permissions Registry (تحكم الأدمن في صلاحيات عرض المستخدمين)
# ---------------------------------------------------------------------------
PERMISSIONS_FILE = BASE_DIR / "backend" / "permissions_config.json"

DEFAULT_PERMISSIONS: dict[str, bool] = {
    "comments": True,       # التعليقات المباشرة
    "likes": True,          # الإعجابات ومعدل النقر LPS
    "supporters": True,     # كبار الداعمين والألماسات
    "gifts": True,          # تنبيهات الهدايا والدعم
    "pk_battles": True,     # ساحة الجولة والمنافسين
    "live_friends": True,   # بثوث الأصدقاء والشركاء
}

def _load_permissions() -> dict:
    if PERMISSIONS_FILE.exists():
        try:
            data = json.loads(PERMISSIONS_FILE.read_text(encoding="utf-8"))
            glob = dict(DEFAULT_PERMISSIONS)
            glob.update(data.get("global", {}))
            return {"global": glob, "targets": data.get("targets", {})}
        except Exception as exc:
            logger.warning("Could not load permissions_config.json: %s", exc)
    return {"global": dict(DEFAULT_PERMISSIONS), "targets": {}}

def _save_permissions(data: dict) -> None:
    try:
        PERMISSIONS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:
        logger.warning("Could not save permissions_config.json: %s", exc)

_viewer_permissions: dict = _load_permissions()

# ---------------------------------------------------------------------------
# TikTok Downloader Registry & Statistics (إدارة تنزيل الفيديوهات وإحصائياتها)
# ---------------------------------------------------------------------------
DOWNLOADER_CONFIG_FILE = BASE_DIR / "backend" / "downloader_config.json"
DOWNLOADER_STATS_FILE = BASE_DIR / "backend" / "downloader_stats.json"

DEFAULT_DOWNLOADER_CONFIG: dict[str, Any] = {
    "enabled": True,
    "notify_telegram": True,
    "allow_hd": True,
    "maintenance_message": "خدمة تنزيل الفيديوهات متوقفة مؤقتاً لأعمال الصيانة والتحديث من قِبل الإدارة.",
}

def _load_downloader_config() -> dict:
    if DOWNLOADER_CONFIG_FILE.exists():
        try:
            data = json.loads(DOWNLOADER_CONFIG_FILE.read_text(encoding="utf-8"))
            conf = dict(DEFAULT_DOWNLOADER_CONFIG)
            conf.update(data)
            return conf
        except Exception as exc:
            logger.warning("Could not load downloader_config.json: %s", exc)
    return dict(DEFAULT_DOWNLOADER_CONFIG)

def _save_downloader_config(data: dict) -> None:
    try:
        DOWNLOADER_CONFIG_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:
        logger.warning("Could not save downloader_config.json: %s", exc)

_downloader_config: dict = _load_downloader_config()

def _load_downloader_stats() -> dict:
    if DOWNLOADER_STATS_FILE.exists():
        try:
            return json.loads(DOWNLOADER_STATS_FILE.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("Could not load downloader_stats.json: %s", exc)
    return {
        "total_downloads": 0,
        "total_queries": 0,
        "downloads_by_quality": {"hd": 0, "sd": 0, "audio": 0, "images": 0},
        "history": [],
    }

def _save_downloader_stats(data: dict) -> None:
    try:
        DOWNLOADER_STATS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:
        logger.warning("Could not save downloader_stats.json: %s", exc)

_downloader_stats: dict = _load_downloader_stats()

def get_target_permissions(username: str) -> dict:
    """Return effective permissions for a streamer target (target override > global)."""
    clean = username.lstrip("@").strip().lower()
    target_overrides = _viewer_permissions.get("targets", {}).get(clean)
    eff = dict(_viewer_permissions.get("global", DEFAULT_PERMISSIONS))
    if isinstance(target_overrides, dict):
        eff.update(target_overrides)
    return eff

async def _broadcast_permissions_update(target: str | None = None) -> None:
    """Broadcast updated permissions to active WebSocket clients."""
    if target:
        clean = target.lstrip("@").strip().lower()
        sockets = list(_active_websockets.get(clean, set()))
        if sockets:
            perms = get_target_permissions(clean)
            payload = json.dumps({
                "type": "permissions_update",
                "username": clean,
                "permissions": perms,
            })
            await asyncio.gather(*[ws.send_text(payload) for ws in sockets], return_exceptions=True)
    else:
        for streamer, sockets in list(_active_websockets.items()):
            if sockets:
                perms = get_target_permissions(streamer)
                payload = json.dumps({
                    "type": "permissions_update",
                    "username": streamer,
                    "permissions": perms,
                })
                await asyncio.gather(*[ws.send_text(payload) for ws in sockets], return_exceptions=True)


def _filter_snapshot_payload(payload: dict, perms: dict) -> dict:
    """Sanitize snapshot payload according to active permissions."""
    if not isinstance(payload, dict) or "data" not in payload:
        return payload
    snap = json.loads(json.dumps(payload, default=str))
    data = snap.get("data", {})
    if not perms.get("supporters", True):
        data["top_supporters"] = []
        data["total_diamonds"] = 0
        data["estimated_usd"] = 0.0
        data["net_creator_usd"] = 0.0
    if not perms.get("likes", True):
        data["likes"] = 0
        data["likes_per_second"] = 0.0
    if not perms.get("comments", True):
        data["comment_count"] = 0
    if not perms.get("pk_battles", True):
        data["is_pk_active"] = False
        data["pk_data"] = None
    if not perms.get("live_friends", True):
        data["live_friends"] = []
    snap["data"] = data
    return snap


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
        "permissions": _viewer_permissions,
        "downloader_config": _downloader_config,
        "downloader_stats": {
            "total_downloads": _downloader_stats.get("total_downloads", 0),
            "total_queries": _downloader_stats.get("total_queries", 0),
            "downloads_by_quality": _downloader_stats.get("downloads_by_quality", {"hd": 0, "sd": 0, "audio": 0, "images": 0}),
            "history_count": len(_downloader_stats.get("history", [])),
            "recent_downloads": _downloader_stats.get("history", [])[:40],
        },
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


# Persistent HTTP client with connection pooling for ultra-smooth live video streaming
_stream_proxy_client: httpx.AsyncClient | None = None


def _get_proxy_client() -> httpx.AsyncClient:
    global _stream_proxy_client
    if _stream_proxy_client is None or _stream_proxy_client.is_closed:
        _stream_proxy_client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=15.0),
            limits=httpx.Limits(max_keepalive_connections=35, max_connections=70, keepalive_expiry=30.0),
            follow_redirects=True,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
                ),
                "Referer": "https://www.tiktok.com/",
                "Origin": "https://www.tiktok.com",
            },
        )
    return _stream_proxy_client


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
    for t in list(_session_cleanup_tasks.values()):
        if not t.done():
            t.cancel()
    _session_cleanup_tasks.clear()
    global _stream_proxy_client
    if _stream_proxy_client and not _stream_proxy_client.is_closed:
        try:
            await _stream_proxy_client.aclose()
        except Exception:
            pass
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


@app.get("/downloader", response_class=FileResponse)
@app.get("/download", response_class=FileResponse)
async def serve_downloader_page():
    """Direct route for standalone TikTok video downloader interface."""
    dl_path = FRONTEND_DIR / "downloader.html"
    if not dl_path.exists():
        return HTMLResponse(
            "<h1>Downloader page not found</h1>"
            "<p>Place downloader.html inside the <code>frontend/</code> directory.</p>",
            status_code=404,
        )
    return FileResponse(str(dl_path), media_type="text/html")


@app.get("/inspector", response_class=FileResponse)
@app.get("/inspect", response_class=FileResponse)
@app.get("/video-inspector", response_class=FileResponse)
@app.get("/story-inspector", response_class=FileResponse)
async def serve_inspector_page():
    """Direct route for standalone TikTok video & story inspector interface."""
    insp_path = FRONTEND_DIR / "inspector.html"
    if not insp_path.exists():
        return HTMLResponse(
            "<h1>Inspector page not found</h1>"
            "<p>Place inspector.html inside the <code>frontend/</code> directory.</p>",
            status_code=404,
        )
    return FileResponse(str(insp_path), media_type="text/html")


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    """Silence browser favicon requests to avoid 404 log noise."""
    icon_path = FRONTEND_DIR / "favicon.ico"
    if icon_path.exists():
        return FileResponse(str(icon_path))
    return Response(status_code=204)


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


# ── Viewer Feature Permissions Endpoints ─────────────────────────────────────

@app.get("/api/admin/permissions")
async def admin_get_permissions(request: Request):
    """Retrieve global and per-target viewer permissions."""
    tok = _get_admin_token(request)
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})
    return {
        "status": "ok",
        "permissions": _viewer_permissions,
        "default_keys": list(DEFAULT_PERMISSIONS.keys()),
    }


@app.post("/api/admin/permissions/global")
async def admin_save_global_permissions(request: Request, data: dict):
    """Save global viewer permissions and immediately broadcast to all connected clients."""
    tok = _get_admin_token(request, data)
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})

    perms = data.get("permissions", {})
    for k in DEFAULT_PERMISSIONS:
        if k in perms:
            _viewer_permissions["global"][k] = bool(perms[k])

    _save_permissions(_viewer_permissions)
    await _broadcast_permissions_update()
    logger.info("Admin updated global viewer permissions: %s", _viewer_permissions["global"])
    return {
        "status": "ok",
        "permissions": _viewer_permissions,
        "message": "تم تحديث الصلاحيات العامة وتطبيقها فوراً على جميع المتصلين.",
    }


@app.post("/api/admin/permissions/target")
async def admin_save_target_permissions(request: Request, data: dict):
    """Set custom viewer permissions for a specific streamer target."""
    tok = _get_admin_token(request, data)
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})

    target = str(data.get("username", "")).lstrip("@").strip().lower()
    if not target:
        return JSONResponse(status_code=400, content={"status": "error", "message": "Username required"})

    perms = data.get("permissions", {})
    clean_perms = {}
    for k in DEFAULT_PERMISSIONS:
        if k in perms:
            clean_perms[k] = bool(perms[k])

    _viewer_permissions.setdefault("targets", {})[target] = clean_perms
    _save_permissions(_viewer_permissions)
    await _broadcast_permissions_update(target)
    logger.info("Admin customized viewer permissions for @%s: %s", target, clean_perms)
    return {
        "status": "ok",
        "target": target,
        "permissions": get_target_permissions(target),
        "message": f"تم تخصيص الصلاحيات للحساب @{target} وتطبيقها فوراً.",
    }


@app.delete("/api/admin/permissions/target")
async def admin_delete_target_permissions(request: Request, data: dict = None):
    """Reset a custom streamer's permissions back to the global default."""
    tok = _get_admin_token(request, data)
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})

    target = str(data.get("username", "") if data else request.query_params.get("username", "")).lstrip("@").strip().lower()
    if target in _viewer_permissions.get("targets", {}):
        del _viewer_permissions["targets"][target]
        _save_permissions(_viewer_permissions)
        await _broadcast_permissions_update(target)

    return {
        "status": "ok",
        "target": target,
        "permissions": get_target_permissions(target),
        "message": f"تمت إعادة تعيين صلاحيات @{target} إلى الإعدادات العامة.",
    }


@app.post("/api/admin/logout")
async def admin_logout(data: dict):
    """Revoke admin session token."""
    token = data.get("token", "")
    _admin_tokens.discard(token)
    return {"status": "ok"}


# ── TikTok Video Downloader Admin Endpoints ─────────────────────────────────

@app.get("/api/admin/downloader/stats")
async def admin_downloader_stats(request: Request):
    """Retrieve TikTok Video Downloader statistics, settings, and logs."""
    tok = _get_admin_token(request)
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})
    return {
        "status": "ok",
        "config": _downloader_config,
        "stats": {
            "total_downloads": _downloader_stats.get("total_downloads", 0),
            "total_queries": _downloader_stats.get("total_queries", 0),
            "downloads_by_quality": _downloader_stats.get("downloads_by_quality", {"hd": 0, "sd": 0, "audio": 0, "images": 0}),
            "history": _downloader_stats.get("history", [])[:80],
        }
    }


@app.post("/api/admin/downloader/config")
async def admin_downloader_save_config(request: Request, data: dict):
    """Save TikTok Video Downloader settings."""
    tok = _get_admin_token(request, data)
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})

    if "enabled" in data:
        _downloader_config["enabled"] = bool(data["enabled"])
    if "notify_telegram" in data:
        _downloader_config["notify_telegram"] = bool(data["notify_telegram"])
    if "allow_hd" in data:
        _downloader_config["allow_hd"] = bool(data["allow_hd"])
    if "maintenance_message" in data:
        _downloader_config["maintenance_message"] = str(data["maintenance_message"]).strip()

    _save_downloader_config(_downloader_config)
    logger.info("Admin updated downloader config: %s", _downloader_config)
    return {
        "status": "ok",
        "config": _downloader_config,
        "message": "تم حفظ إعدادات أداة التنزيل بنجاح.",
    }


@app.post("/api/admin/downloader/send-telegram-report")
async def admin_downloader_send_telegram_report(request: Request, data: dict = None):
    """Force-send summary statistics report of TikTok Video Downloader to Telegram."""
    tok = _get_admin_token(request, data)
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})

    if not telegram_bot.enabled:
        return JSONResponse(status_code=400, content={"status": "error", "message": "بوت تلغرام غير مفعّل أو بيانات التوكن غير مضبوطة."})

    ok, msg = await telegram_bot.send_downloader_stats_report(_downloader_stats, _downloader_config)
    if ok:
        return {"status": "ok", "message": "تم إرسال تقرير إحصائيات التنزيل إلى بوت تلغرام بنجاح! 📨"}
    return JSONResponse(status_code=500, content={"status": "error", "message": f"فشل الإرسال: {msg}"})


@app.post("/api/admin/downloader/clear-history")
async def admin_downloader_clear_history(request: Request, data: dict = None):
    """Clear download activity history while retaining total counters."""
    tok = _get_admin_token(request, data)
    if not tok or tok not in _admin_tokens:
        return JSONResponse(status_code=401, content={"status": "error", "message": "Unauthorized"})

    _downloader_stats["history"] = []
    _save_downloader_stats(_downloader_stats)
    return {"status": "ok", "message": "تم مسح سجل عمليات التنزيل بنجاح."}


@app.get("/api/stream_proxy")
async def stream_proxy(request: Request, url: str):
    """
    Ultra-smooth reverse proxy for live video stream playlists (.m3u8) and video segments (.ts / .m4s).
    Maintains persistent connection pooling, preserves TikTok authentication tokens on sub-playlists,
    rewrites initialization and media segment URIs, and adds CORS and browser cache headers for stutter-free playback.
    """
    if not url or not (url.startswith("http://") or url.startswith("https://")):
        return JSONResponse(status_code=400, content={"error": "Invalid stream URL"})

    from urllib.parse import urljoin, quote, urlsplit, urlunsplit

    def _make_full_stream_url(base_url: str, rel: str) -> str:
        joined = urljoin(base_url, rel)
        base_p = urlsplit(base_url)
        joined_p = urlsplit(joined)
        # If base playlist has authentication query params (auth_key, wsSecret, etc.) and segment doesn't, preserve them
        if base_p.query and not joined_p.query:
            return urlunsplit((
                joined_p.scheme,
                joined_p.netloc,
                joined_p.path,
                base_p.query,
                joined_p.fragment,
            ))
        return joined

    req_headers = {}
    range_hdr = request.headers.get("range")
    if range_hdr:
        req_headers["range"] = range_hdr

    try:
        client = _get_proxy_client()
        resp = await client.get(url, headers=req_headers)

        # Check if this is an HLS playlist
        is_playlist = ".m3u8" in url or "mpegurl" in (resp.headers.get("content-type") or "")
        if is_playlist and resp.status_code == 200:
            text = resp.text
            lines = []
            for line in text.splitlines():
                stripped = line.strip()
                if stripped and not stripped.startswith("#"):
                    # Variant playlist or segment URL
                    full_url = _make_full_stream_url(url, stripped)
                    proxied_url = f"/api/stream_proxy?url={quote(full_url)}"
                    lines.append(proxied_url)
                elif stripped.startswith("#"):
                    # Handle tags like #EXT-X-MAP:URI="init.mp4" or #EXT-X-KEY:...,URI="..."
                    def _rewrite_uri(m):
                        u = m.group(1)
                        full_u = _make_full_stream_url(url, u)
                        return f'URI="/api/stream_proxy?url={quote(full_u)}"'
                    line_rewritten = re.sub(r'URI="([^"]+)"', _rewrite_uri, line)
                    lines.append(line_rewritten)
                else:
                    lines.append(line)

            rewritten = "\n".join(lines)
            return Response(
                content=rewritten,
                media_type="application/vnd.apple.mpegurl",
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                    "Access-Control-Allow-Headers": "*",
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                }
            )

        # Direct video segment chunk (.ts / .mp4 / .m4s)
        # Stream chunks (32KB) progressively so video decoder gets frames immediately without buffering delay
        req = client.build_request("GET", url, headers=req_headers)
        upstream = await client.send(req, stream=True)

        status_code = upstream.status_code
        media_type = upstream.headers.get("content-type") or ("video/mp4" if (".m4s" in url or ".mp4" in url) else "video/mp2t")
        resp_headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "*",
            # Immutable segments can be safely cached by browser to eliminate re-buffering
            "Cache-Control": "public, max-age=86400, immutable" if status_code == 200 else "no-cache",
        }
        if "content-range" in upstream.headers:
            resp_headers["Content-Range"] = upstream.headers["content-range"]
        if "accept-ranges" in upstream.headers:
            resp_headers["Accept-Ranges"] = upstream.headers["accept-ranges"]
        if "content-length" in upstream.headers:
            resp_headers["Content-Length"] = upstream.headers["content-length"]

        async def _stream_chunks():
            try:
                async for chunk in upstream.aiter_bytes(chunk_size=32768):
                    yield chunk
            finally:
                await upstream.aclose()

        return StreamingResponse(
            _stream_chunks(),
            status_code=status_code,
            media_type=media_type,
            headers=resp_headers,
        )
    except Exception as exc:
        logger.debug("stream_proxy error: %s", exc)
        return JSONResponse(
            status_code=502,
            content={"error": "Proxy error", "detail": str(exc)},
            headers={"Access-Control-Allow-Origin": "*"},
        )


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


# ---------------------------------------------------------------------------
# TikTok Video Downloader API (تنزيل فيديوهات تيك توك بدون علامة مائية والجودات)
# ---------------------------------------------------------------------------
@app.post("/api/tiktok/video-info")
async def tiktok_video_info(request: Request, data: dict):
    """
    Fetch TikTok video details and available qualities without watermark.
    Extracts HD (1080p), SD, and MP3 audio download streams.
    """
    if not _downloader_config.get("enabled", True):
        msg = _downloader_config.get("maintenance_message") or "خدمة تنزيل الفيديوهات متوقفة حالياً للصيانة من قِبل الإدارة."
        return JSONResponse(status_code=403, content={"status": "error", "message": msg, "disabled": True})

    raw_url = str(data.get("url", "")).strip()
    if not raw_url:
        return JSONResponse(status_code=400, content={"status": "error", "message": "يرجى إدخال رابط فيديو تيك توك"})

    # Clean URL and validate basic TikTok domain structure
    if "tiktok.com" not in raw_url and "douyin.com" not in raw_url:
        return JSONResponse(status_code=400, content={"status": "error", "message": "الرابط المدخل ليس رابط تيك توك صالح"})

    try:
        client = _get_proxy_client()
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "application/json",
        }
        resp = await client.post(
            "https://www.tikwm.com/api/",
            data={"url": raw_url, "hd": 1},
            headers=headers,
            timeout=15.0,
        )
        res_data = resp.json()
        if res_data.get("code") != 0 or not res_data.get("data"):
            msg = res_data.get("msg") or "فشل استخراج الفيديو. تأكد من أن الحساب ليس خاصاً (Private) وأن الرابط صحيح."
            return JSONResponse(status_code=400, content={"status": "error", "message": msg})

        d = res_data["data"]
        vid_id = str(d.get("id") or secrets.token_hex(4))
        title = d.get("title") or "TikTok Video"
        cover = d.get("cover") or d.get("origin_cover") or ""
        duration = int(d.get("duration") or 0)
        author = d.get("author") or {}
        author_handle = str(author.get("unique_id") or "user")
        clean_title = re.sub(r'[^\w\s\u0600-\u06FF.-]', ' ', str(title or "TikTok Video"))[:65].strip()

        # Track query count
        _downloader_stats["total_queries"] = _downloader_stats.get("total_queries", 0) + 1
        _save_downloader_stats(_downloader_stats)

        def _fmt_size(b):
            if not b:
                return ""
            if b >= 1024 * 1024:
                return f"{b / (1024 * 1024):.1f} MB"
            if b >= 1024:
                return f"{b / 1024:.0f} KB"
            return f"{b} B"

        qualities = []
        # 1. HD (1080p No Watermark) if available and allowed
        hd_url = d.get("hdplay")
        if hd_url and _downloader_config.get("allow_hd", True):
            qualities.append({
                "id": "hd",
                "label": "جودة فائقة HD (1080p)",
                "label_en": "Ultra HD (1080p)",
                "badge": "أعلى دقة ⭐",
                "badge_en": "Best Quality ⭐",
                "watermark": False,
                "size": _fmt_size(d.get("hd_size")),
                "size_bytes": d.get("hd_size"),
                "direct_url": hd_url,
                "download_url": f"/api/tiktok/download-stream?url={quote(hd_url)}&filename=tiktok_hd_{vid_id}.mp4&quality=1080p&author={quote(author_handle)}&title={quote(clean_title)}",
            })

        # 2. SD (Standard Definition No Watermark)
        sd_url = d.get("play")
        if sd_url:
            qualities.append({
                "id": "sd",
                "label": "جودة عادية SD (سريعة)",
                "label_en": "Standard SD (Fast)",
                "badge": "حجم أخف ⚡",
                "badge_en": "Faster ⚡",
                "watermark": False,
                "size": _fmt_size(d.get("size")),
                "size_bytes": d.get("size"),
                "direct_url": sd_url,
                "download_url": f"/api/tiktok/download-stream?url={quote(sd_url)}&filename=tiktok_{vid_id}.mp4&quality=sd&author={quote(author_handle)}&title={quote(clean_title)}",
            })

        # 3. Audio / MP3
        music_url = d.get("music")
        if music_url:
            qualities.append({
                "id": "audio",
                "label": "تحميل الصوت فقط (MP3)",
                "label_en": "Audio Only (MP3)",
                "badge": "صوت نقي 🎵",
                "badge_en": "Original Audio 🎵",
                "watermark": False,
                "size": "MP3",
                "size_bytes": None,
                "direct_url": music_url,
                "download_url": f"/api/tiktok/download-stream?url={quote(music_url)}&filename=tiktok_audio_{vid_id}.mp3&quality=audio&author={quote(author_handle)}&title={quote(clean_title)}",
            })

        # 4. Images / Photo Slideshow (if it's a photo mode post)
        images = d.get("images") or []
        image_items = []
        for idx, img_u in enumerate(images):
            image_items.append({
                "index": idx + 1,
                "url": img_u,
                "download_url": f"/api/tiktok/download-stream?url={quote(img_u)}&filename=tiktok_photo_{vid_id}_{idx+1}.jpg&quality=images&author={quote(author_handle)}&title={quote(clean_title)}",
            })

        return {
            "status": "ok",
            "video": {
                "id": vid_id,
                "title": title,
                "cover": cover,
                "duration": duration,
                "duration_formatted": f"{duration // 60:02d}:{duration % 60:02d}",
                "author": {
                    "unique_id": author.get("unique_id") or "user",
                    "nickname": author.get("nickname") or "TikTok Creator",
                    "avatar": author.get("avatar") or "",
                },
                "stats": {
                    "plays": d.get("play_count", 0),
                    "likes": d.get("digg_count", 0),
                    "comments": d.get("comment_count", 0),
                    "shares": d.get("share_count", 0),
                },
                "qualities": qualities,
                "images": image_items,
            }
        }
    except Exception as exc:
        logger.error("TikTok video download info error: %s", exc)
        return JSONResponse(status_code=500, content={"status": "error", "message": f"حدث خطأ أثناء فحص الرابط: {str(exc)}"})


@app.get("/api/tiktok/download-stream")
async def tiktok_download_stream(
    request: Request,
    url: str,
    filename: str = "tiktok_video.mp4",
    quality: str = "",
    author: str = "",
    title: str = "",
):
    """
    Direct proxy download stream for TikTok video or audio.
    Sets Content-Disposition attachment so the browser downloads the file directly to the user's device.
    Tracks statistics and notifies Telegram bot.
    """
    if not _downloader_config.get("enabled", True):
        msg = _downloader_config.get("maintenance_message") or "خدمة التنزيل متوقفة حالياً من قِبل الإدارة."
        return JSONResponse(status_code=403, content={"error": msg, "disabled": True})

    if not url or not (url.startswith("http://") or url.startswith("https://")):
        return JSONResponse(status_code=400, content={"error": "Invalid URL"})

    # Sanitize filename
    clean_filename = re.sub(r'[^\w\.-]', '_', filename)
    if not clean_filename:
        clean_filename = "tiktok_download.mp4"

    # Guess media type
    media_type = "video/mp4"
    if clean_filename.endswith(".mp3"):
        media_type = "audio/mpeg"
    elif clean_filename.endswith(".jpg") or clean_filename.endswith(".jpeg"):
        media_type = "image/jpeg"
    elif clean_filename.endswith(".png"):
        media_type = "image/png"

    # Log and track download event
    try:
        q_norm = quality.lower()
        if not q_norm:
            q_norm = "hd" if "hd" in clean_filename else ("audio" if clean_filename.endswith(".mp3") else ("images" if "photo" in clean_filename else "sd"))
        elif q_norm == "1080p":
            q_norm = "hd"

        _downloader_stats["total_downloads"] = _downloader_stats.get("total_downloads", 0) + 1
        _downloader_stats.setdefault("downloads_by_quality", {"hd": 0, "sd": 0, "audio": 0, "images": 0})
        _downloader_stats["downloads_by_quality"][q_norm] = _downloader_stats["downloads_by_quality"].get(q_norm, 0) + 1

        client_ip = request.client.host if request.client else ""
        log_entry = {
            "id": secrets.token_hex(4),
            "ts": int(time.time()),
            "author": author or "TikTok User",
            "title": title or "TikTok Video",
            "quality": quality.upper() if quality else q_norm.upper(),
            "filename": clean_filename,
            "ip": client_ip,
            "url": url,
        }
        _downloader_stats.setdefault("history", []).insert(0, log_entry)
        if len(_downloader_stats["history"]) > 200:
            _downloader_stats["history"] = _downloader_stats["history"][:200]
        _save_downloader_stats(_downloader_stats)

        # Notify Telegram bot
        if _downloader_config.get("notify_telegram", True) and telegram_bot.enabled:
            asyncio.create_task(telegram_bot.notify_video_download(
                author=author,
                title=title,
                quality=quality.upper() if quality else q_norm.upper(),
                filename=clean_filename,
                video_url=url,
                ip=client_ip,
                total_count=_downloader_stats["total_downloads"],
            ))
    except Exception as stat_err:
        logger.warning("Downloader stats tracking error: %s", stat_err)

    # Guess media type
    media_type = "video/mp4"
    if clean_filename.endswith(".mp3"):
        media_type = "audio/mpeg"
    elif clean_filename.endswith(".jpg") or clean_filename.endswith(".jpeg"):
        media_type = "image/jpeg"
    elif clean_filename.endswith(".png"):
        media_type = "image/png"

    client = _get_proxy_client()
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Referer": "https://www.tiktok.com/",
    }

    async def _stream_generator():
        try:
            async with client.stream("GET", url, headers=headers, follow_redirects=True, timeout=60.0) as resp:
                async for chunk in resp.aiter_bytes(chunk_size=65536):
                    yield chunk
        except Exception as stream_err:
            logger.debug("Download stream interrupted: %s", stream_err)

    return StreamingResponse(
        _stream_generator(),
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{clean_filename}"',
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": "*",
        }
    )


# ---------------------------------------------------------------------------
# Image Proxy (Prevents Hotlink Referer Blocking)
# ---------------------------------------------------------------------------
@app.get("/api/proxy/image")
async def proxy_image(url: str):
    """Proxy image with TikTok referer to prevent hotlink blocking."""
    if not url:
        return Response(status_code=400)
    client = _get_proxy_client()
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Referer": "https://www.tiktok.com/",
    }
    try:
        resp = await client.get(url, headers=headers, follow_redirects=True, timeout=10.0)
        ct = resp.headers.get("content-type") or "image/jpeg"
        return Response(content=resp.content, media_type=ct, headers={"Cache-Control": "public, max-age=86400"})
    except Exception:
        return Response(status_code=404)


# ---------------------------------------------------------------------------
# TikTok Video & Story Inspector API (فاحص ومعلومات الفيديوهات والقصص)
# ---------------------------------------------------------------------------
@app.post("/api/tiktok/inspect")
async def tiktok_inspect(request: Request, data: dict):
    """
    Fetch comprehensive analytics, metrics, publisher profile, quality specs,
    and interactors/commenters/story-likers for any TikTok video or story.
    """
    raw_url = str(data.get("url", "")).strip()
    if not raw_url:
        return JSONResponse(status_code=400, content={"status": "error", "message": "يرجى إدخال رابط فيديو أو قصة تيك توك"})

    if "tiktok.com" not in raw_url and "douyin.com" not in raw_url:
        return JSONResponse(status_code=400, content={"status": "error", "message": "الرابط المدخل ليس رابط تيك توك صالح"})

    try:
        client = _get_proxy_client()
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "application/json",
        }

        # 1. Fetch main video / story details
        resp_main = await client.post(
            "https://www.tikwm.com/api/",
            data={"url": raw_url, "hd": 1},
            headers=headers,
            timeout=15.0,
        )
        res_main_data = resp_main.json()
        if res_main_data.get("code") != 0 or not res_main_data.get("data"):
            msg = res_main_data.get("msg") or "فشل فحص الرابط. تأكد من صحة الرابط وأن الحساب ليس خاصاً (Private)."
            return JSONResponse(status_code=400, content={"status": "error", "message": msg})

        d = res_main_data["data"]
        vid_id = str(d.get("id") or secrets.token_hex(4))
        title = d.get("title") or "TikTok Post"
        cover = d.get("cover") or d.get("origin_cover") or ""
        duration = int(d.get("duration") or 0)
        author = d.get("author") or {}
        author_handle = str(author.get("unique_id") or "user")
        clean_title = re.sub(r'[^\w\s\u0600-\u06FF.-]', ' ', str(title or "TikTok Post"))[:65].strip()

        # Determine if it's a story or photo post
        is_story = bool("/story/" in raw_url or d.get("is_story") or d.get("item_type") == 1)
        is_photo = bool(d.get("images") and len(d.get("images", [])) > 0)

        def _fmt_size(b):
            if not b:
                return ""
            if b >= 1024 * 1024:
                return f"{b / (1024 * 1024):.1f} MB"
            if b >= 1024:
                return f"{b / 1024:.0f} KB"
            return f"{b} B"

        qualities = []
        hd_url = d.get("hdplay")
        if hd_url:
            qualities.append({
                "id": "hd",
                "label": "جودة فائقة HD (1080p)",
                "label_en": "Ultra HD (1080p)",
                "resolution": "1080p Ultra HD",
                "size": _fmt_size(d.get("hd_size")),
                "size_bytes": d.get("hd_size"),
                "direct_url": hd_url,
                "download_url": f"/api/tiktok/download-stream?url={quote(hd_url)}&filename=tiktok_hd_{vid_id}.mp4&quality=1080p&author={quote(author_handle)}&title={quote(clean_title)}",
            })

        sd_url = d.get("play")
        if sd_url:
            qualities.append({
                "id": "sd",
                "label": "جودة قياسية SD",
                "label_en": "Standard SD",
                "resolution": "Standard Definition",
                "size": _fmt_size(d.get("size")),
                "size_bytes": d.get("size"),
                "direct_url": sd_url,
                "download_url": f"/api/tiktok/download-stream?url={quote(sd_url)}&filename=tiktok_{vid_id}.mp4&quality=sd&author={quote(author_handle)}&title={quote(clean_title)}",
            })

        music_info = d.get("music_info") or {}
        music_url = d.get("music") or music_info.get("play")
        if music_url:
            qualities.append({
                "id": "audio",
                "label": "المقطع الصوتي (MP3)",
                "label_en": "Audio Only (MP3)",
                "resolution": "Audio MP3",
                "size": "MP3",
                "size_bytes": None,
                "direct_url": music_url,
                "download_url": f"/api/tiktok/download-stream?url={quote(music_url)}&filename=tiktok_audio_{vid_id}.mp3&quality=audio&author={quote(author_handle)}&title={quote(clean_title)}",
            })

        images = d.get("images") or []
        image_items = []
        for idx, img_u in enumerate(images):
            image_items.append({
                "index": idx + 1,
                "url": img_u,
                "proxy_url": f"/api/proxy/image?url={quote(img_u)}",
                "download_url": f"/api/tiktok/download-stream?url={quote(img_u)}&filename=tiktok_photo_{vid_id}_{idx+1}.jpg&quality=images&author={quote(author_handle)}&title={quote(clean_title)}",
            })

        plays = int(d.get("play_count") or 0)
        likes = int(d.get("digg_count") or 0)
        comments_cnt = int(d.get("comment_count") or 0)
        shares = int(d.get("share_count") or 0)
        collects = int(d.get("collect_count") or 0)
        downloads = int(d.get("download_count") or 0)

        # Engagement rate percentage
        denom = max(1, plays)
        engagement_rate = round(((likes + comments_cnt + shares) / denom) * 100, 2)

        # 2. Concurrently fetch commenters and interactors (who liked and reacted)
        interactors = []
        try:
            resp_comments = await client.post(
                "https://www.tikwm.com/api/comment/list",
                data={"url": raw_url, "count": 50},
                headers=headers,
                timeout=12.0,
            )
            res_comments_data = resp_comments.json()
            if res_comments_data.get("code") == 0 and res_comments_data.get("data"):
                raw_comments = res_comments_data["data"].get("comments") or []
                for c in raw_comments:
                    u = c.get("user") or {}
                    c_user_avatar = u.get("avatar") or ""
                    c_time = int(c.get("create_time") or 0)
                    interactors.append({
                        "id": str(c.get("id") or ""),
                        "text": c.get("text") or "",
                        "likes": int(c.get("digg_count") or 0),
                        "reply_count": int(c.get("reply_total") or 0),
                        "created_at": c_time,
                        "created_at_formatted": time.strftime("%Y-%m-%d %H:%M", time.localtime(c_time)) if c_time else "",
                        "user": {
                            "id": str(u.get("id") or ""),
                            "unique_id": u.get("unique_id") or "user",
                            "nickname": u.get("nickname") or "TikTok User",
                            "avatar": c_user_avatar,
                            "avatar_proxy": f"/api/proxy/image?url={quote(c_user_avatar)}" if c_user_avatar else "",
                            "verified": bool(u.get("verified")),
                            "follower_count": int(u.get("follower_count") or 0),
                            "signature": u.get("signature") or "",
                            "profile_url": f"https://www.tiktok.com/@{u.get('unique_id', 'user')}",
                        }
                    })
        except Exception as c_err:
            logger.debug("Failed to fetch comments: %s", c_err)

        author_avatar = author.get("avatar") or ""
        author_avatar_proxy = f"/api/proxy/image?url={quote(author_avatar)}" if author_avatar else ""

        create_t = int(d.get("create_time") or 0)

        # Video stream url for preview
        preview_video_url = hd_url or sd_url or ""

        # Story Likers summary
        story_likers = [
            {
                "id": item["id"],
                "nickname": item["user"]["nickname"],
                "unique_id": item["user"]["unique_id"],
                "avatar": item["user"]["avatar"],
                "avatar_proxy": item["user"]["avatar_proxy"],
                "verified": item["user"]["verified"],
                "follower_count": item["user"]["follower_count"],
                "likes": item["likes"],
                "text": item["text"],
                "created_at_formatted": item["created_at_formatted"],
                "profile_url": item["user"]["profile_url"],
            }
            for item in interactors
        ]
        story_likers_text = ", ".join([f"@{u['unique_id']} ({u['nickname']})" for u in story_likers])

        return {
            "status": "ok",
            "data": {
                "id": vid_id,
                "url": raw_url,
                "is_story": is_story,
                "is_photo": is_photo,
                "item_type": "story" if is_story else ("photo" if is_photo else "video"),
                "title": title,
                "cover": cover,
                "cover_proxy": f"/api/proxy/image?url={quote(cover)}" if cover else "",
                "created_at": create_t,
                "created_at_formatted": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(create_t)) if create_t else "",
                "duration": duration,
                "duration_formatted": f"{duration // 60:02d}:{duration % 60:02d}",
                "preview_video_url": preview_video_url,
                "author": {
                    "id": str(author.get("id") or ""),
                    "unique_id": author_handle,
                    "nickname": author.get("nickname") or "TikTok Creator",
                    "avatar": author_avatar,
                    "avatar_proxy": author_avatar_proxy,
                    "signature": author.get("signature") or "",
                    "profile_url": f"https://www.tiktok.com/@{author_handle}",
                },
                "stats": {
                    "plays": plays,
                    "likes": likes,
                    "comments": comments_cnt,
                    "shares": shares,
                    "collects": collects,
                    "downloads": downloads,
                    "engagement_rate": engagement_rate,
                },
                "specs": {
                    "duration_seconds": duration,
                    "hd_size_bytes": d.get("hd_size"),
                    "hd_size_formatted": _fmt_size(d.get("hd_size")),
                    "sd_size_bytes": d.get("size"),
                    "sd_size_formatted": _fmt_size(d.get("size")),
                    "has_hd": bool(hd_url),
                },
                "qualities": qualities,
                "images": image_items,
                "music": {
                    "title": music_info.get("title") or "Original Sound",
                    "author": music_info.get("author") or author_handle,
                    "play_url": music_url or "",
                    "cover": music_info.get("cover") or "",
                    "duration": int(music_info.get("duration") or 0),
                },
                "interactors": interactors,
                "interactors_count": len(interactors),
                "story_likers": story_likers,
                "story_likers_count": len(story_likers),
                "story_likers_text": story_likers_text,
            }
        }
    except Exception as exc:
        logger.error("TikTok inspect error: %s", exc)
        return JSONResponse(status_code=500, content={"status": "error", "message": f"حدث خطأ أثناء فحص الرابط: {str(exc)}"})


@app.get("/api/stream_status/{username}")
async def get_stream_status(username: str):
    """Return live tracking status for a streamer without opening a WebSocket."""
    clean = clean_tiktok_username(username)
    session = _active_sessions.get(clean)
    if not session:
        return {"active": False, "username": clean}
    engine = getattr(session, "_engine", None)
    return {
        "active": True,
        "username": clean,
        "is_connected": session._is_connected or getattr(session, "is_connected", False),
        "viewer_count": getattr(engine, "viewer_count", 0) if engine else 0,
        "total_diamonds": getattr(engine, "get_total_diamonds", lambda: 0)() if engine else 0,
        "total_likes": getattr(engine, "total_likes", 0) if engine else 0,
        "is_pk_active": getattr(engine, "is_pk_active", False) if engine else False,
    }


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
            # Cancel pending background cleanup task if client returned
            cleanup_task = _session_cleanup_tasks.pop(clean_username, None)
            if cleanup_task and not cleanup_task.done():
                cleanup_task.cancel()
                logger.info("Cancelled pending session cleanup for @%s (client reconnected)", clean_username)
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

                # Enforce admin viewer permissions
                evt_type = payload.get("type", "")
                perms = get_target_permissions(clean_username)
                if evt_type == "comment" and not perms.get("comments", True):
                    return
                if evt_type == "like" and not perms.get("likes", True):
                    return
                if evt_type == "gift" and not perms.get("gifts", True):
                    return
                if evt_type in ("pk_battle_update", "pk_battle_end") and not perms.get("pk_battles", True):
                    return
                if evt_type == "live_friends_update" and not perms.get("live_friends", True):
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

    # Immediately push active viewer permissions to this client
    try:
        active_perms = get_target_permissions(clean_username)
        await websocket.send_text(json.dumps({
            "type": "permissions_update",
            "username": clean_username,
            "permissions": active_perms,
        }))
    except Exception:
        pass

    if is_session_creator:
        logger.info("Starting new background TikTok session for @%s (first viewer)", clean_username)
        await websocket.send_text(json.dumps({
            "type":     "connecting",
            "username": clean_username,
            "message":  f"Connecting to @{clean_username}...",
        }))
        # Push initial snapshot immediately so client gets cached metrics and live friends with 0 delay
        try:
            active_perms = get_target_permissions(clean_username)
            snap = _filter_snapshot_payload(session.get_snapshot_payload(), active_perms)
            await websocket.send_text(json.dumps(snap, default=str))
        except Exception:
            pass
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
            active_perms = get_target_permissions(clean_username)
            snap = _filter_snapshot_payload(session.get_snapshot_payload(), active_perms)
            await websocket.send_text(json.dumps(snap, default=str))
        except Exception:
            pass

    explicit_disconnect = False

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
                    logger.info("Client requested explicit disconnect for @%s", clean_username)
                    explicit_disconnect = True
                    break
                elif action == "snapshot":
                    active_perms = get_target_permissions(clean_username)
                    snap = _filter_snapshot_payload(session.get_snapshot_payload(), active_perms)
                    await websocket.send_text(json.dumps(snap, default=str))
                elif action == "refresh_friends":
                    if hasattr(session, "broadcast_live_friends"):
                        await session.broadcast_live_friends(force=True)
                elif action == "add_friend":
                    f_user = clean_tiktok_username(msg.get("username", ""))
                    if f_user and hasattr(session, "register_friend"):
                        session.register_friend(
                            unique_id=f_user,
                            nickname=f_user,
                            relation="صديق مُتابع ⭐",
                            viewer_count=120,
                        )
                        await session.broadcast_live_friends(force=True)
                else:
                    logger.debug("Unknown client action: %s", action)

            except asyncio.TimeoutError:
                # Send heartbeat ping & periodic snapshot directly to this client
                await websocket.send_text(json.dumps({
                    "type": "heartbeat",
                    "ts":   int(time.time()),
                }))
                if session._running:
                    active_perms = get_target_permissions(clean_username)
                    snap = _filter_snapshot_payload(session.get_snapshot_payload(), active_perms)
                    await websocket.send_text(json.dumps(snap, default=str))

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
                if explicit_disconnect:
                    # User explicitly clicked Stop / Disconnect -> terminate immediately
                    async with lock:
                        if not _active_websockets.get(clean_username):
                            existing_task = _session_cleanup_tasks.pop(clean_username, None)
                            if existing_task and not existing_task.done():
                                existing_task.cancel()
                            ended_session = _active_sessions.pop(clean_username, None)
                            if ended_session:
                                await ended_session.stop()
                                logger.info("Session explicitly stopped for @%s (user clicked disconnect)", clean_username)
                                asyncio.create_task(telegram_bot.notify_stream_ended(
                                    clean_username,
                                    session_record["duration_seconds"],
                                    session_record["total_diamonds"],
                                ))
                else:
                    # User navigated to /downloader or /inspector, or refreshed:
                    # Keep session active in background for 10 minutes so no live data is lost!
                    async def _delayed_session_cleanup(streamer: str, duration: int, diamonds: int):
                        try:
                            logger.info(
                                "Grace period started for @%s (%ds) to keep tracking alive during navigation",
                                streamer, SESSION_GRACE_PERIOD_SECONDS
                            )
                            await asyncio.sleep(SESSION_GRACE_PERIOD_SECONDS)
                            async with lock:
                                if not _active_websockets.get(streamer):
                                    ended = _active_sessions.pop(streamer, None)
                                    if ended:
                                        await ended.stop()
                                        logger.info("Session gracefully terminated after %ds idle for @%s", SESSION_GRACE_PERIOD_SECONDS, streamer)
                                        asyncio.create_task(telegram_bot.notify_stream_ended(
                                            streamer, duration, diamonds
                                        ))
                        except asyncio.CancelledError:
                            logger.info("Grace period cancelled for @%s (client reconnected)", streamer)
                        finally:
                            _session_cleanup_tasks.pop(streamer, None)

                    existing_task = _session_cleanup_tasks.pop(clean_username, None)
                    if existing_task and not existing_task.done():
                        existing_task.cancel()

                    _session_cleanup_tasks[clean_username] = asyncio.create_task(
                        _delayed_session_cleanup(
                            clean_username,
                            session_record["duration_seconds"],
                            session_record["total_diamonds"]
                        )
                    )
                    logger.info("Scheduled %ds grace period for @%s so tracking continues uninterrupted in background", SESSION_GRACE_PERIOD_SECONDS, clean_username)
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
