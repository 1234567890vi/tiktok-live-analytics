# =============================================================================
#  backend/tiktok_listener.py
#  Manages TikTokLive client instances, wires TikTok events to the C++ engine,
#  and broadcasts JSON messages over a FastAPI WebSocket connection.
# =============================================================================

from __future__ import annotations

import asyncio
import logging
import sys
import time
import types
from typing import Callable, Awaitable

from TikTokLive import TikTokLiveClient
from TikTokLive.events import (
    ConnectEvent,
    DisconnectEvent,
    CommentEvent,
    GiftEvent,
    LikeEvent,
    ViewerCountEvent,
    LinkMicBattleEvent,
    LinkMicArmiesEvent,
)

from backend.config import DIAMOND_TO_USD_RATE, NET_PAYOUT_RATIO

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Try to import the C++ engine; fall back to a pure-Python stub so the app
# remains importable even before the extension is compiled (dev mode).
# ---------------------------------------------------------------------------
try:
    import tiktok_cpp_engine as _cpp  # type: ignore

    LiveRoomEngine = _cpp.LiveRoomEngine
    CPP_AVAILABLE = True
    logger.info("✅ tiktok_cpp_engine (C++ core) loaded successfully.")
except ModuleNotFoundError:
    CPP_AVAILABLE = False
    logger.warning(
        "⚠️  tiktok_cpp_engine C++ module not found. "
        "Using pure-Python fallback. Run `pip install .` to build the engine."
    )

    # Define fallback only when C++ is not available
    class _PyEngine:  # type: ignore[no-redef]
        """
        Pure-Python mirror of LiveRoomEngine for development without C++ build.
        Provides an identical public interface so the rest of the codebase is unchanged.
        """

        def __init__(self, host: str = "") -> None:
            self._host       = host
            self._likes      = 0
            self._diamonds   = 0
            self._comments   = 0
            self._viewers    = 0
            self._likers:     dict = {}
            self._supporters: dict = {}
            self._streaks:    dict = {}
            self._pk:         dict = {}
            self._comment_buf: list = []
            self._like_times:  list = []

        def reset(self) -> None:
            self.__init__(self._host)

        def update_viewer_count(self, n: int) -> None:
            self._viewers = n

        def process_like(self, uid, uniq, nick, av, lc, total):
            self._likes = max(self._likes, total)
            rec = self._likers.setdefault(uid, {
                "user_id": uid, "unique_id": uniq,
                "nickname": nick, "avatar_url": av, "like_count": 0,
            })
            rec["like_count"] += lc
            self._like_times.append((time.time(), lc))
            return self._likes

        def process_comment(self, uid, uniq, nick, av, text, ts, level=0):
            item = {
                "user_id": uid, "unique_id": uniq, "nickname": nick,
                "avatar_url": av, "comment_text": text,
                "timestamp_ms": ts, "user_level": level,
            }
            if len(self._comment_buf) >= 200:
                self._comment_buf.pop(0)
            self._comment_buf.append(item)
            self._comments += 1

            class _C:
                def to_dict(self_): return item  # noqa: N805
            return _C()

        def process_gift(self, uid, uniq, nick, av, gid, gname, gicon, udiam, rc, streak):
            key = f"{uid}_{gid}"
            prev = self._streaks.get(key, 0)

            if streak:
                # Ongoing streak: charge only the delta since last event
                delta = max(0, rc - prev)
                self._streaks[key] = rc
            else:
                # Streak ended or non-streakable gift: charge remaining delta and clear
                already_charged = prev
                self._streaks.pop(key, None)
                delta = max(0, rc - already_charged)

            val = delta * udiam
            self._diamonds += val
            sup = self._supporters.setdefault(uid, {
                "user_id": uid, "unique_id": uniq, "nickname": nick,
                "avatar_url": av, "total_diamonds": 0, "gift_count": 0,
            })
            sup["total_diamonds"] += val
            if delta > 0:
                sup["gift_count"] += 1

            txn = {
                "gift_id": gid, "gift_name": gname, "gift_icon_url": gicon,
                "diamond_unit_cost": udiam, "repeat_count": rc,
                "is_streak_ending": not streak, "total_value": val,
            }

            class _T:
                def to_dict(self_): return txn  # noqa: N805
            return _T()

        def update_pk_battle(self, bid, active, host, opp, hs, os_):
            was_active = self._pk.get("is_active", False)
            host_wins    = self._pk.get("host_wins", 0)
            opponent_wins = self._pk.get("opponent_wins", 0)
            round_number  = self._pk.get("round_number", 1)

            # Auto-tally wins on active → ended transition (same battle_id)
            if was_active and not active and self._pk.get("battle_id") == bid:
                if self._pk.get("host_points", 0) >= self._pk.get("opponent_points", 0):
                    host_wins += 1
                else:
                    opponent_wins += 1
                round_number += 1

            self._pk = {
                "is_active": active, "battle_id": bid,
                "host_username": host, "opponent_username": opp,
                "host_points": hs, "opponent_points": os_,
                "host_wins": host_wins, "opponent_wins": opponent_wins,
                "round_number": round_number,
            }

        def get_top_supporters(self, limit: int = 10):
            sups = sorted(
                self._supporters.values(),
                key=lambda x: x["total_diamonds"], reverse=True
            )[:limit]
            result = []
            for s in sups:
                class _S:
                    _d = s
                    def to_dict(self_): return self_._d  # noqa: N805
                result.append(_S())
            return result

        def get_lps(self) -> float:
            now = time.time()
            self._like_times = [(t, c) for t, c in self._like_times if now - t <= 5.0]
            if not self._like_times:
                return 0.0
            total = sum(c for _, c in self._like_times)
            window = min(now - self._like_times[0][0], 5.0)
            return total / window if window > 0 else 0.0

        def get_total_diamonds(self) -> int: return self._diamonds
        def get_total_likes(self)    -> int: return self._likes
        def get_total_comments(self) -> int: return self._comments

        def get_pk_state(self):
            pk = dict(self._pk)
            class _PK:
                def to_dict(self_): return pk  # noqa: N805
            return _PK()

        def get_dashboard_snapshot(self):
            sups = sorted(
                self._supporters.values(),
                key=lambda x: x["total_diamonds"], reverse=True
            )[:10]
            likers = sorted(
                self._likers.values(),
                key=lambda x: x["like_count"], reverse=True
            )[:10]
            snap = {
                "total_likes":      self._likes,
                "likes_per_second": self.get_lps(),
                "viewer_count":     self._viewers,
                "total_diamonds":   self._diamonds,
                "estimated_usd":    self._diamonds * 0.005,
                "net_payout_usd":   self._diamonds * 0.005 * 0.5,
                "total_comments":   self._comments,
                "pk_state":         dict(self._pk),
                "top_supporters":   sups,
                "top_likers":       likers,
            }

            class _S:
                def to_dict(self_): return snap  # noqa: N805
            return _S()

    LiveRoomEngine = _PyEngine  # type: ignore[assignment, misc]


# ---------------------------------------------------------------------------
# Type alias for the broadcast coroutine injected by main.py
# ---------------------------------------------------------------------------
BroadcastFn = Callable[[dict], Awaitable[None]]


# ---------------------------------------------------------------------------
# Helper: safe attribute extraction from TikTokLive event objects
# ---------------------------------------------------------------------------

def _safe(obj, *attrs, default=""):
    """Traverse nested attributes safely, returning `default` on any miss."""
    for attr in attrs:
        if obj is None:
            return default
        try:
            obj = getattr(obj, attr, None)
        except Exception:
            return default
    return obj if obj is not None else default


def _user_info(user) -> dict:
    """Extract standardised user dict from a TikTokLive user object."""
    if user is None:
        return {"user_id": "", "unique_id": "", "nickname": "", "avatar_url": ""}
    avatar = ""
    av_thumb = _safe(user, "avatar_thumb")
    if av_thumb:
        urls = _safe(av_thumb, "url_list")
        if urls and isinstance(urls, (list, tuple)) and len(urls) > 0:
            avatar = urls[0]
    return {
        "user_id":    str(_safe(user, "id",        default="")),
        "unique_id":  str(_safe(user, "unique_id",  default="")),
        "nickname":   str(_safe(user, "nickname",   default="")),
        "avatar_url": str(avatar),
    }


# ---------------------------------------------------------------------------
# TikTokSession — wraps one live room tracking session
# ---------------------------------------------------------------------------

class TikTokSession:
    """
    Manages the lifecycle of tracking a single TikTok Live room.
    One instance is created per WebSocket connection.
    """

    def __init__(self, username: str, broadcast: BroadcastFn) -> None:
        self.username   = username.lstrip("@")
        self._broadcast = broadcast
        self._engine    = LiveRoomEngine(self.username)
        self._client: TikTokLiveClient | None = None
        self._running   = False
        self._task: asyncio.Task | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Connect to the TikTok Live room and start event processing."""
        if self._running:
            return
        self._running = True
        self._engine.reset()

        self._client = TikTokLiveClient(unique_id=f"@{self.username}")
        self._register_handlers()

        # Run client in a background task so we don't block the WS loop
        self._task = asyncio.create_task(
            self._run_client(), name=f"tiktok-{self.username}"
        )

    async def stop(self) -> None:
        """Gracefully stop the tracking session."""
        self._running = False
        if self._client:
            try:
                await self._client.disconnect()
            except Exception:
                pass
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("Session stopped for @%s", self.username)

    async def send_snapshot(self) -> None:
        """Push the current dashboard snapshot to the WebSocket client."""
        snap = self._engine.get_dashboard_snapshot()
        data = snap.to_dict() if hasattr(snap, "to_dict") else snap

        # Enrich computed fields
        data["total_coins"]    = data.get("total_diamonds", 0)
        data["estimated_usd"]  = round(
            data.get("total_diamonds", 0) * DIAMOND_TO_USD_RATE, 4
        )
        data["net_payout_usd"] = round(
            data.get("estimated_usd", 0.0) * NET_PAYOUT_RATIO, 4
        )

        await self._send({"type": "snapshot", "data": data})

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    async def _run_client(self) -> None:
        try:
            await self._client.start()
        except Exception as exc:
            logger.error("TikTokLive client error for @%s: %s", self.username, exc)
            await self._send({
                "type":    "error",
                "message": str(exc),
                "detail":  (
                    f"Could not connect to @{self.username}. "
                    "The user may be offline or the username is incorrect."
                ),
            })
        finally:
            self._running = False

    def _register_handlers(self) -> None:
        client = self._client

        # ---- Connect ----
        @client.on(ConnectEvent)
        async def on_connect(event: ConnectEvent):
            logger.info("Connected to @%s (room_id=%s)", self.username, event.room_id)
            await self._send({
                "type":     "connected",
                "username": self.username,
                "room_id":  str(event.room_id),
            })
            await self.send_snapshot()

        # ---- Disconnect ----
        @client.on(DisconnectEvent)
        async def on_disconnect(event: DisconnectEvent):
            logger.info("Disconnected from @%s", self.username)
            await self._send({"type": "disconnected", "username": self.username})

        # ---- Viewer Count ----
        @client.on(ViewerCountEvent)
        async def on_viewers(event: ViewerCountEvent):
            viewer_count = _safe(event, "viewer_count", default=0)
            self._engine.update_viewer_count(int(viewer_count))
            await self._send({
                "type": "viewers",
                "data": {"viewer_count": int(viewer_count)},
            })

        # ---- Comments ----
        @client.on(CommentEvent)
        async def on_comment(event: CommentEvent):
            user  = _safe(event, "user")
            uinfo = _user_info(user)
            text  = str(_safe(event, "comment", default=""))
            ts_ms = int(time.time() * 1000)

            badge_level = 0
            badges = _safe(user, "badges")
            if badges and isinstance(badges, (list, tuple)) and len(badges) > 0:
                badge_level = int(_safe(badges[0], "level", default=0))

            comment = self._engine.process_comment(
                uinfo["user_id"], uinfo["unique_id"],
                uinfo["nickname"], uinfo["avatar_url"],
                text, ts_ms, badge_level,
            )

            payload = comment.to_dict() if hasattr(comment, "to_dict") else comment
            payload["badge_level"] = badge_level

            await self._send({"type": "comment", "data": payload})

        # ---- Likes ----
        @client.on(LikeEvent)
        async def on_like(event: LikeEvent):
            user  = _safe(event, "user")
            uinfo = _user_info(user)
            like_count       = int(_safe(event, "like_count",       default=0))
            total_room_likes = int(_safe(event, "total_like_count", default=0))

            total = self._engine.process_like(
                uinfo["user_id"], uinfo["unique_id"],
                uinfo["nickname"], uinfo["avatar_url"],
                like_count, total_room_likes,
            )
            lps = self._engine.get_lps()

            await self._send({
                "type": "like",
                "data": {
                    "user_id":          uinfo["user_id"],
                    "unique_id":        uinfo["unique_id"],
                    "nickname":         uinfo["nickname"],
                    "avatar_url":       uinfo["avatar_url"],
                    "like_count":       like_count,
                    "total_likes":      total,
                    "likes_per_second": round(lps, 2),
                },
            })

        # ---- Gifts ----
        @client.on(GiftEvent)
        async def on_gift(event: GiftEvent):
            user  = _safe(event, "user")
            uinfo = _user_info(user)

            gift       = _safe(event, "gift")
            gift_id    = str(_safe(gift, "id",   default="0"))
            gift_name  = str(_safe(gift, "name", default="Unknown Gift"))
            gift_icon  = ""
            icon_obj   = _safe(gift, "image")
            if icon_obj:
                icon_urls = _safe(icon_obj, "url_list")
                if icon_urls and isinstance(icon_urls, (list, tuple)) and len(icon_urls) > 0:
                    gift_icon = icon_urls[0]

            unit_diamonds = int(_safe(gift, "diamond_count", default=0))
            repeat_count  = int(_safe(event, "repeat_count", default=1))

            # TikTokLive v6: gift.streakable = can combo; event.streaking = currently in streak
            streakable    = bool(_safe(gift,  "streakable", default=False))
            streaking_now = bool(_safe(event, "streaking",  default=False))
            streak_active = streakable and streaking_now

            txn = self._engine.process_gift(
                uinfo["user_id"], uinfo["unique_id"],
                uinfo["nickname"], uinfo["avatar_url"],
                gift_id, gift_name, gift_icon,
                unit_diamonds, repeat_count, streak_active,
            )

            txn_dict = txn.to_dict() if hasattr(txn, "to_dict") else txn

            supporters  = self._engine.get_top_supporters(10)
            leaderboard = [
                (s.to_dict() if hasattr(s, "to_dict") else s)
                for s in supporters
            ]

            total_diamonds = self._engine.get_total_diamonds()
            estimated_usd  = round(total_diamonds * DIAMOND_TO_USD_RATE, 4)
            net_payout     = round(estimated_usd * NET_PAYOUT_RATIO, 4)

            await self._send({
                "type": "gift",
                "data": {
                    "user":           uinfo,
                    "transaction":    txn_dict,
                    "streak_active":  streak_active,
                    "repeat_count":   repeat_count,
                    "total_diamonds": total_diamonds,
                    "estimated_usd":  estimated_usd,
                    "net_payout_usd": net_payout,
                },
                "leaderboard": leaderboard,
            })

        # ---- PK Battle Start ----
        @client.on(LinkMicBattleEvent)
        async def on_pk_battle(event: LinkMicBattleEvent):
            battle_id = str(_safe(event, "battle_id", default=""))
            self._engine.update_pk_battle(
                battle_id, True,
                self.username, "opponent",
                0, 0,
            )
            pk = self._engine.get_pk_state()
            pk_dict = pk.to_dict() if hasattr(pk, "to_dict") else pk.__dict__
            await self._send({"type": "pk_battle", "data": pk_dict, "event": "start"})

        # ---- PK Armies Update ----
        @client.on(LinkMicArmiesEvent)
        async def on_pk_armies(event: LinkMicArmiesEvent):
            battle_id = str(_safe(event, "battle_id", default=""))
            armies    = _safe(event, "battle_groups")

            host_score     = 0
            opponent_score = 0
            host_name      = self.username
            opponent_name  = "opponent"

            if armies and isinstance(armies, (list, tuple)):
                if len(armies) >= 1:
                    g0         = armies[0]
                    host_score = int(_safe(g0, "points", default=0))
                    members_0  = _safe(g0, "users")
                    if members_0 and len(members_0) > 0:
                        host_name = str(_safe(members_0[0], "unique_id", default=self.username))
                if len(armies) >= 2:
                    g1             = armies[1]
                    opponent_score = int(_safe(g1, "points", default=0))
                    members_1      = _safe(g1, "users")
                    if members_1 and len(members_1) > 0:
                        opponent_name = str(_safe(members_1[0], "unique_id", default="opponent"))

            is_finished = bool(_safe(event, "is_finished", default=False))
            is_active   = not is_finished

            self._engine.update_pk_battle(
                battle_id, is_active,
                host_name, opponent_name,
                host_score, opponent_score,
            )

            pk = self._engine.get_pk_state()
            pk_dict = pk.to_dict() if hasattr(pk, "to_dict") else pk.__dict__

            await self._send({
                "type":  "pk_battle",
                "data":  pk_dict,
                "event": "ended" if is_finished else "update",
            })

    async def _send(self, payload: dict) -> None:
        """Safely call the broadcast coroutine (swallows closed-socket errors)."""
        try:
            await self._broadcast(payload)
        except Exception as exc:
            logger.debug("WebSocket send error: %s", exc)
