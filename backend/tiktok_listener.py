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
    RoomUserSeqEvent,
    LinkMicBattleEvent,
    LinkMicArmiesEvent,
    LinkMicBattlePunishFinishEvent,
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
            self._comment_buf: list = []
            self._like_times:  list = []
            self._pk: dict = {
                "is_active": False,
                "status": "IDLE",            # ACTIVE | PUNISH | ENDED | IDLE
                "battle_id": "",
                "round_number": 1,
                "host_wins": 0,
                "opponent_wins": 0,
                "host_points": 0,
                "opponent_points": 0,
                "host_username": host,
                "opponent_username": "الخصم",
                "battle_type": "1v1",
                "host_anchors": [],
                "opponent_anchors": [],
                "host_armies": [],
                "opponent_armies": [],
            }

        def reset(self) -> None:
            self.__init__(self._host)

        def update_viewer_count(self, n: int) -> None:
            if n > 0:
                self._viewers = n

        def set_total_diamonds(self, n: int) -> None:
            self._diamonds = max(self._diamonds, n)

        def set_total_likes(self, n: int) -> None:
            self._likes = max(self._likes, n)

        def update_supporter_score(self, uid, uniq, nick, av, score: int) -> None:
            if not uid:
                return
            sup = self._supporters.setdefault(uid, {
                "user_id": uid, "unique_id": uniq, "nickname": nick,
                "avatar_url": av, "total_diamonds": 0, "gift_count": 0,
            })
            sup["total_diamonds"] = max(sup["total_diamonds"], score)

        def process_like(self, uid, uniq, nick, av, lc, total):
            self._likes = max(self._likes, total)
            if uid:
                rec = self._likers.setdefault(uid, {
                    "user_id": uid, "unique_id": uniq,
                    "nickname": nick, "avatar_url": av, "like_count": 0,
                })
                rec["like_count"] += lc
            if lc > 0:
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

        def update_pk_battle(
            self,
            bid: str = "",
            active: bool = False,
            host: str = "",
            opp: str = "",
            hs: int = 0,
            os_: int = 0,
            status: str = "IDLE",
            battle_type: str = "1v1",
            host_anchors: list | None = None,
            opponent_anchors: list | None = None,
            host_armies: list | None = None,
            opponent_armies: list | None = None,
        ):
            was_active = self._pk.get("is_active", False)
            host_wins    = self._pk.get("host_wins", 0)
            opponent_wins = self._pk.get("opponent_wins", 0)
            round_number  = self._pk.get("round_number", 1)

            # Transition from active to ended: auto-tally winner
            if was_active and (status == "ENDED" or not active):
                if hs > os_:
                    host_wins += 1
                elif os_ > hs:
                    opponent_wins += 1
                round_number += 1

            prev_host_anchors = self._pk.get("host_anchors", [])
            prev_opp_anchors = self._pk.get("opponent_anchors", [])
            prev_host_armies = self._pk.get("host_armies", [])
            prev_opp_armies = self._pk.get("opponent_armies", [])

            self._pk = {
                "is_active": active,
                "status": status,
                "battle_id": bid or self._pk.get("battle_id", ""),
                "host_username": host or self._pk.get("host_username", self._host),
                "opponent_username": opp or self._pk.get("opponent_username", "الخصم"),
                "host_points": hs,
                "opponent_points": os_,
                "host_wins": host_wins,
                "opponent_wins": opponent_wins,
                "round_number": round_number,
                "battle_type": battle_type or self._pk.get("battle_type", "1v1"),
                "host_anchors": host_anchors if host_anchors is not None else prev_host_anchors,
                "opponent_anchors": opponent_anchors if opponent_anchors is not None else prev_opp_anchors,
                "host_armies": host_armies if host_armies is not None else prev_host_armies,
                "opponent_armies": opponent_armies if opponent_armies is not None else prev_opp_armies,
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


def _extract_avatar(obj) -> str:
    """Extract avatar URL safely from any user or image proto object."""
    if not obj:
        return ""
    if isinstance(obj, str) and obj.startswith("http"):
        return obj
    for attr in ("avatar_thumb", "avatar_medium", "avatar_large", "avatar", "image"):
        sub = _safe(obj, attr)
        if sub:
            urls = _safe(sub, "url_list")
            if urls and isinstance(urls, (list, tuple)) and len(urls) > 0:
                return str(urls[0])
            if isinstance(sub, str) and sub.startswith("http"):
                return sub
    urls = _safe(obj, "url_list")
    if urls and isinstance(urls, (list, tuple)) and len(urls) > 0:
        return str(urls[0])
    return ""


def _parse_anchor_user(wrapper, default_anchor_id: str = "") -> dict:
    """Extract anchor details from BattleUserInfoWrapper or similar."""
    key = str(_safe(wrapper, "key", default=default_anchor_id))
    val = _safe(wrapper, "value", default=wrapper)
    user = _safe(val, "user", default=val)

    u_id = str(_safe(user, "id", default=key) or key)
    unique_id = str(_safe(user, "display_id", default="") or _safe(user, "unique_id", default=""))
    nickname = str(_safe(user, "nickname", default="") or unique_id or f"User_{u_id[:6] if u_id else 'pk'}")
    avatar_url = _extract_avatar(user)

    return {
        "anchor_id": key or u_id,
        "user_id": u_id,
        "unique_id": unique_id,
        "nickname": nickname,
        "avatar_url": avatar_url,
    }


def _parse_battle_anchors_and_teams(
    event, current_username: str, streamer_uid: str = "", streamer_avatar: str = ""
):
    """
    Parses anchors_info and team_member from LinkMicBattleEvent.
    Returns: (host_anchors, opponent_anchors, battle_type)
    """
    current_lower = current_username.lower().lstrip("@")
    anchors_info = _safe(event, "anchors_info")
    anchors = []

    if anchors_info and isinstance(anchors_info, (list, tuple)):
        for item in anchors_info:
            anchors.append(_parse_anchor_user(item))
    elif isinstance(anchors_info, dict):
        for k, v in anchors_info.items():
            class _W:
                key = k
                value = v
            anchors.append(_parse_anchor_user(_W()))

    # Check team_member
    team_members = _safe(event, "team_member")
    teams_dict = {}  # team_id -> list of user_ids (str)
    if team_members and isinstance(team_members, (list, tuple)):
        for tm in team_members:
            tid = _safe(tm, "team_id", default=0)
            uids = [str(x) for x in (_safe(tm, "user_id") or [])]
            if uids:
                teams_dict[tid] = uids

    host_anchors = []
    opponent_anchors = []

    if teams_dict and len(teams_dict) >= 2:
        # Find which team belongs to current_username / streamer_uid
        host_team_id = None
        for tid, uids in teams_dict.items():
            for a in anchors:
                if (a["user_id"] in uids or a["anchor_id"] in uids) and (
                    a["unique_id"].lower() == current_lower
                    or (streamer_uid and a["user_id"] == streamer_uid)
                ):
                    host_team_id = tid
                    break
            if host_team_id is not None:
                break

        if host_team_id is not None:
            for a in anchors:
                a_uids = teams_dict.get(host_team_id, [])
                if a["user_id"] in a_uids or a["anchor_id"] in a_uids:
                    a["is_host_side"] = True
                    host_anchors.append(a)
                else:
                    a["is_host_side"] = False
                    opponent_anchors.append(a)

    # Fallback if no team_members or grouping failed
    if not host_anchors and anchors:
        for a in anchors:
            if a["unique_id"].lower() == current_lower or (
                streamer_uid and a["user_id"] == streamer_uid
            ):
                a["is_host_side"] = True
                host_anchors.append(a)
            else:
                a["is_host_side"] = False
                opponent_anchors.append(a)

        # If still no host matched, assign first to host
        if not host_anchors and opponent_anchors:
            first = opponent_anchors.pop(0)
            first["is_host_side"] = True
            host_anchors.append(first)

    # If anchors list was completely empty
    if not host_anchors:
        host_anchors = [{
            "anchor_id": streamer_uid or "0",
            "user_id": streamer_uid or "0",
            "unique_id": current_username,
            "nickname": current_username,
            "avatar_url": streamer_avatar,
            "is_host_side": True,
        }]
    if not opponent_anchors:
        opponent_anchors = [{
            "anchor_id": "opp",
            "user_id": "opp",
            "unique_id": "opponent",
            "nickname": "الخصم",
            "avatar_url": "",
            "is_host_side": False,
        }]

    battle_type = "2v2" if (len(host_anchors) + len(opponent_anchors)) > 2 else "1v1"
    return host_anchors, opponent_anchors, battle_type


def _parse_armies_dict(armies_field) -> dict:
    """Parses armies from LinkMicBattleEvent or LinkMicArmiesEvent into structured dict."""
    armies_data = {}
    if isinstance(armies_field, dict):
        items = list(armies_field.items())
    elif isinstance(armies_field, (list, tuple)):
        items = []
        for it in armies_field:
            k = _safe(it, "key", default=None)
            v = _safe(it, "value", default=it)
            if k is not None:
                items.append((k, v))
            else:
                anchor_id = str(_safe(v, "anchor_id_str", default="") or _safe(v, "anchor_id", default=""))
                if anchor_id:
                    items.append((anchor_id, v))
    else:
        items = []

    for key, army_obj in items:
        aid = str(key)
        score = int(_safe(army_obj, "hostscore", default=0) or 0)
        user_armies = _safe(army_obj, "user_armies") or []
        contributors = []
        if isinstance(user_armies, (list, tuple)):
            for c in user_armies:
                c_uid = str(_safe(c, "user_id", default="") or _safe(c, "user_id_str", default=""))
                c_nick = str(_safe(c, "nickname", default="داعـم"))
                c_score = int(_safe(c, "score", default=0) or 0)
                c_diam = int(_safe(c, "diamond_score", default=0) or 0)
                c_av = _extract_avatar(_safe(c, "avatar_thumb"))
                contributors.append({
                    "user_id": c_uid,
                    "nickname": c_nick,
                    "score": c_score,
                    "diamond_score": c_diam,
                    "avatar_url": c_av,
                })
        contributors.sort(key=lambda x: x["score"], reverse=True)
        armies_data[aid] = {
            "score": score,
            "contributors": contributors,
        }
    return armies_data


def _aggregate_team_armies(anchors: list, armies_dict: dict):
    """Calculates total team score and top 3 contributors (MVPs)."""
    team_score = 0
    all_contributors = []
    seen_users = set()

    for a in anchors:
        aid = a.get("anchor_id", "")
        uid = a.get("user_id", "")
        entry = armies_dict.get(aid) or armies_dict.get(uid) or {}
        team_score += entry.get("score", 0)
        for c in entry.get("contributors", []):
            if c["user_id"] not in seen_users:
                seen_users.add(c["user_id"])
                all_contributors.append(c)

    all_contributors.sort(key=lambda x: x["score"], reverse=True)
    return team_score, all_contributors[:3]


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
        self._streamer_user_id   = ""
        self._streamer_unique_id = ""
        self._streamer_nickname  = ""
        self._streamer_avatar    = ""

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
        backoff = 2
        while self._running:
            try:
                logger.info("Connecting to @%s (backoff=%ds)...", self.username, backoff)
                # Use connect() with process_connect_events=True — blocks while stream is running
                await self._client.connect(process_connect_events=True)

                if not self._running:
                    break

                # If connect() completes cleanly while self._running is True, the connection dropped
                logger.info("Connection dropped for @%s, auto-reconnecting...", self.username)
                await self._send({
                    "type": "reconnecting",
                    "username": self.username,
                    "message": "Connection lost. Reconnecting to live...",
                })
                await asyncio.sleep(backoff)
                self._client = TikTokLiveClient(unique_id=f"@{self.username}")
                self._register_handlers()

            except asyncio.CancelledError:
                break
            except Exception as exc:
                if not self._running:
                    break
                logger.warning(
                    "TikTokLive error for @%s: %s. Reconnecting in %ds...",
                    self.username, exc, backoff
                )
                await self._send({
                    "type": "reconnecting",
                    "username": self.username,
                    "message": f"Connection interrupted ({exc}). Reconnecting...",
                })
                await asyncio.sleep(backoff)
                backoff = min(int(backoff * 1.5), 10)
                self._client = TikTokLiveClient(unique_id=f"@{self.username}")
                self._register_handlers()
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

            # Fetch initial room info safely
            try:
                r_info = await client._web.fetch_room_info()
                if r_info and isinstance(r_info, dict):
                    owner = r_info.get("owner", {}) or {}
                    if owner:
                        self._streamer_user_id   = str(owner.get("id", "") or owner.get("id_str", ""))
                        self._streamer_unique_id = str(owner.get("display_id", "") or self.username)
                        self._streamer_nickname  = str(owner.get("nickname", "") or self.username)
                        self._streamer_avatar    = _extract_avatar(owner)

                    init_likes = int(r_info.get("like_count", 0) or 0)
                    if init_likes > 0:
                        self._engine.set_total_likes(init_likes)

                    init_viewers = int(r_info.get("user_count", 0) or 0)
                    if init_viewers > 0:
                        self._engine.update_viewer_count(init_viewers)

                    init_diamonds = int(r_info.get("fan_ticket_count", 0) or 0)
                    if init_diamonds > 0:
                        self._engine.set_total_diamonds(init_diamonds)
            except Exception as e:
                logger.debug("Optional initial room_info fetch: %s", e)

            await self.send_snapshot()

        # ---- Disconnect ----
        @client.on(DisconnectEvent)
        async def on_disconnect(event: DisconnectEvent):
            logger.info("Disconnected event from @%s", self.username)
            if not self._running:
                await self._send({"type": "disconnected", "username": self.username})

        # ---- Viewer Count (RoomUserSeqEvent in TikTokLive v7) ----
        @client.on(RoomUserSeqEvent)
        async def on_viewers(event: RoomUserSeqEvent):
            viewers = int(_safe(event, "total", default=0) or _safe(event, "total_user", default=0))
            if viewers > 0:
                self._engine.update_viewer_count(viewers)

            ranks = _safe(event, "ranks")
            if ranks and isinstance(ranks, (list, tuple)):
                for contributor in ranks:
                    c_user = _safe(contributor, "user")
                    if c_user:
                        c_uinfo = _user_info(c_user)
                        c_score = int(_safe(contributor, "score", default=0))
                        if c_score > 0 and c_uinfo["user_id"]:
                            self._engine.update_supporter_score(
                                c_uinfo["user_id"], c_uinfo["unique_id"],
                                c_uinfo["nickname"], c_uinfo["avatar_url"],
                                c_score
                            )

            supporters = self._engine.get_top_supporters(10)
            leaderboard = [
                (s.to_dict() if hasattr(s, "to_dict") else s)
                for s in supporters
            ]

            await self._send({
                "type": "viewers",
                "data": {"viewer_count": getattr(self._engine, "_viewers", viewers)},
                "leaderboard": leaderboard,
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
            like_count       = int(_safe(event, "count", default=0))
            total_room_likes = int(_safe(event, "total", default=0))

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

            gift      = _safe(event, "gift")
            gift_id   = str(_safe(event, "gift_id", default=0) or _safe(gift, "id", default="0"))
            gift_name = str(_safe(gift, "name", default="Unknown Gift"))
            gift_icon = _extract_avatar(gift) or _extract_avatar(_safe(gift, "image"))

            unit_diamonds = int(_safe(gift, "diamond_count", default=0) or _safe(event, "fan_ticket_count", default=0))
            repeat_count  = int(_safe(event, "repeat_count", default=1) or 1)
            repeat_end    = int(_safe(event, "repeat_end", default=0))
            streak_active = (repeat_end == 0)

            room_fan_tickets = int(_safe(event, "room_fan_ticket_count", default=0))

            # Determine recipient side during PK Battle
            to_user = _safe(event, "to_user")
            to_uid  = str(_safe(to_user, "id", default="") or _safe(event, "to_member_id_int", default=""))
            to_uniq = str(_safe(to_user, "display_id", default="") or _safe(to_user, "unique_id", default=""))

            pk_st = self._engine.get_pk_state()
            pk_dict = pk_st.to_dict() if hasattr(pk_st, "to_dict") else pk_st.__dict__
            is_pk = pk_dict.get("is_active", False)

            recipient_side = "host"
            recipient_name = self._streamer_nickname or self.username

            if is_pk:
                opps  = pk_dict.get("opponent_anchors", [])
                hosts = pk_dict.get("host_anchors", [])
                is_opp = False
                for op in opps:
                    if (to_uid and to_uid == op.get("user_id")) or (
                        to_uniq and to_uniq.lower() == op.get("unique_id", "").lower()
                    ):
                        is_opp = True
                        recipient_name = op.get("nickname") or op.get("unique_id") or "الخصم"
                        break
                if is_opp:
                    recipient_side = "opponent"
                else:
                    for h in hosts:
                        if (to_uid and to_uid == h.get("user_id")) or (
                            to_uniq and to_uniq.lower() == h.get("unique_id", "").lower()
                        ):
                            recipient_name = h.get("nickname") or h.get("unique_id") or self.username
                            break

            txn = self._engine.process_gift(
                uinfo["user_id"], uinfo["unique_id"],
                uinfo["nickname"], uinfo["avatar_url"],
                gift_id, gift_name, gift_icon,
                unit_diamonds, repeat_count, streak_active,
            )

            if room_fan_tickets > 0:
                self._engine.set_total_diamonds(room_fan_tickets)

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
                    "recipient_side": recipient_side,
                    "recipient_name": recipient_name,
                    "is_battle_gift": is_pk,
                },
                "leaderboard": leaderboard,
            })

        # ---- PK Battle Start / State Change ----
        @client.on(LinkMicBattleEvent)
        async def on_pk_battle(event: LinkMicBattleEvent):
            battle_id = str(_safe(event, "battle_id", default=""))
            host_anchors, opp_anchors, b_type = _parse_battle_anchors_and_teams(
                event, self.username, self._streamer_user_id, self._streamer_avatar
            )

            armies_raw = _safe(event, "armies")
            armies_dict = _parse_armies_dict(armies_raw)
            host_score, host_mvps = _aggregate_team_armies(host_anchors, armies_dict)
            opp_score, opp_mvps   = _aggregate_team_armies(opp_anchors, armies_dict)

            # Determine action / status
            act = _safe(event, "action", default=4)
            act_str = str(act).upper()
            if act == 4 or "OPEN" in act_str or act_str == "4":
                status = "ACTIVE"
                is_active = True
            elif act == 5 or "FINISH" in act_str or act_str == "5":
                status = "PUNISH"
                is_active = True
            elif act in (3, 6, 11) or any(x in act_str for x in ("CANCEL", "CUT_SHORT", "LEAVE")):
                status = "ENDED"
                is_active = False
            else:
                status = "ACTIVE" if battle_id else "IDLE"
                is_active = bool(battle_id)

            host_name = host_anchors[0].get("unique_id", self.username) if host_anchors else self.username
            opp_name  = opp_anchors[0].get("unique_id", "opponent") if opp_anchors else "opponent"

            self._engine.update_pk_battle(
                bid=battle_id,
                active=is_active,
                host=host_name,
                opp=opp_name,
                hs=host_score,
                os_=opp_score,
                status=status,
                battle_type=b_type,
                host_anchors=host_anchors,
                opponent_anchors=opp_anchors,
                host_armies=host_mvps,
                opponent_armies=opp_mvps,
            )

            pk = self._engine.get_pk_state()
            pk_dict = pk.to_dict() if hasattr(pk, "to_dict") else pk.__dict__
            event_tag = "start" if status == "ACTIVE" else ("ended" if status == "ENDED" else "update")
            await self._send({"type": "pk_battle", "data": pk_dict, "event": event_tag})

        # ---- PK Armies Live Points & Contributors Update ----
        @client.on(LinkMicArmiesEvent)
        async def on_pk_armies(event: LinkMicArmiesEvent):
            battle_id  = str(_safe(event, "battle_id", default=""))
            armies_raw = _safe(event, "armies")
            armies_dict = _parse_armies_dict(armies_raw)

            curr_pk = self._engine.get_pk_state()
            curr_pk_dict = curr_pk.to_dict() if hasattr(curr_pk, "to_dict") else curr_pk.__dict__
            host_anchors = curr_pk_dict.get("host_anchors", [])
            opp_anchors  = curr_pk_dict.get("opponent_anchors", [])

            if not host_anchors or not opp_anchors:
                host_anchors, opp_anchors, _ = _parse_battle_anchors_and_teams(
                    event, self.username, self._streamer_user_id, self._streamer_avatar
                )

            host_score, host_mvps = _aggregate_team_armies(host_anchors, armies_dict)
            opp_score, opp_mvps   = _aggregate_team_armies(opp_anchors, armies_dict)

            host_score = max(host_score, curr_pk_dict.get("host_points", 0))
            opp_score  = max(opp_score, curr_pk_dict.get("opponent_points", 0))

            is_finished = bool(_safe(event, "is_finished", default=False))
            status = "ENDED" if is_finished else "ACTIVE"
            is_active = not is_finished

            self._engine.update_pk_battle(
                bid=battle_id,
                active=is_active,
                hs=host_score,
                os_=opp_score,
                status=status,
                host_anchors=host_anchors,
                opponent_anchors=opp_anchors,
                host_armies=host_mvps,
                opponent_armies=opp_mvps,
            )

            pk = self._engine.get_pk_state()
            pk_dict = pk.to_dict() if hasattr(pk, "to_dict") else pk.__dict__

            # Check if this armies event carried a battle gift alert
            gift_id    = int(_safe(event, "gift_id", default=0) or 0)
            diam_count = int(_safe(event, "total_diamond_count", default=0) or 0)
            from_uid   = str(_safe(event, "from_user_id", default="0") or "0")
            if gift_id > 0 and diam_count > 0 and from_uid != "0":
                sender_nick = "داعـم"
                sender_av   = ""
                for c in (host_mvps + opp_mvps):
                    if c.get("user_id") == from_uid:
                        sender_nick = c.get("nickname") or "داعـم"
                        sender_av   = c.get("avatar_url") or ""
                        break
                gift_icon = _extract_avatar(_safe(event, "gift_icon_image"))
                await self._send({
                    "type": "gift",
                    "data": {
                        "user": {
                            "user_id": from_uid,
                            "unique_id": "",
                            "nickname": sender_nick,
                            "avatar_url": sender_av,
                        },
                        "transaction": {
                            "gift_id": str(gift_id),
                            "gift_name": "PK Gift",
                            "gift_icon_url": gift_icon,
                            "diamond_unit_cost": diam_count,
                            "repeat_count": int(_safe(event, "repeat_count", default=1) or 1),
                            "is_streak_ending": True,
                            "total_value": diam_count,
                        },
                        "streak_active": False,
                        "repeat_count": int(_safe(event, "repeat_count", default=1) or 1),
                        "total_diamonds": self._engine.get_total_diamonds(),
                        "estimated_usd": round(self._engine.get_total_diamonds() * DIAMOND_TO_USD_RATE, 4),
                        "net_payout_usd": round(self._engine.get_total_diamonds() * DIAMOND_TO_USD_RATE * NET_PAYOUT_RATIO, 4),
                        "recipient_side": "host",
                        "recipient_name": self.username,
                        "is_battle_gift": True,
                    },
                    "leaderboard": [(s.to_dict() if hasattr(s, "to_dict") else s) for s in self._engine.get_top_supporters(10)],
                })

            await self._send({
                "type":  "pk_battle",
                "data":  pk_dict,
                "event": "ended" if is_finished else "update",
            })

        # ---- PK Punishment Finish ----
        @client.on(LinkMicBattlePunishFinishEvent)
        async def on_pk_punish_finish(event: LinkMicBattlePunishFinishEvent):
            bid = str(_safe(event, "battle_id", default=""))
            self._engine.update_pk_battle(
                bid=bid,
                active=False,
                status="ENDED",
            )
            pk = self._engine.get_pk_state()
            pk_dict = pk.to_dict() if hasattr(pk, "to_dict") else pk.__dict__
            await self._send({"type": "pk_battle", "data": pk_dict, "event": "ended"})

    async def _send(self, payload: dict) -> None:
        """Safely call the broadcast coroutine (swallows closed-socket errors)."""
        try:
            await self._broadcast(payload)
        except Exception as exc:
            logger.debug("WebSocket send error: %s", exc)
