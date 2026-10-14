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
import os
import json

from TikTokLive import TikTokLiveClient
from TikTokLive.client.web.web_settings import WebDefaults
from TikTokLive.client.errors import (
    UserOfflineError,
    UserNotFoundError,
    SignatureRateLimitError,
    SignAPIError,
    WebcastBlockedError,
    WebcastBlocked200Error,
    InitialCursorMissingError,
)
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

# Optional battle events depending on TikTokLive version
try:
    from TikTokLive.events import LinkMicBattleItemCardEvent  # type: ignore
except ImportError:
    LinkMicBattleItemCardEvent = None

try:
    from TikTokLive.events import LinkMicFanTicketMethodEvent  # type: ignore
except ImportError:
    LinkMicFanTicketMethodEvent = None

from backend.config import DIAMOND_TO_USD_RATE, NET_PAYOUT_RATIO, SIGN_API_KEY

if SIGN_API_KEY:
    WebDefaults.tiktok_sign_api_key = SIGN_API_KEY

# Comprehensive fallback diamond prices for well-known TikTok gifts in English and Arabic
COMMON_TIKTOK_GIFTS: dict[str, int] = {
    # 1 Diamond
    "rose": 1, "وردة": 1, "ورده": 1,
    "tiktok": 1, "تيك توك": 1, "تيكتوك": 1,
    "heart me": 1, "قلبي": 1, "قلب": 1,
    "ice cream cone": 1, "مثلجات": 1, "ايس كريم": 1,
    "gg": 1, "جي جي": 1,
    "football": 1, "كرة قدم": 1, "كرة": 1,
    "mini speaker": 1, "مكبر صوت": 1, "مكبر": 1,
    "star": 1, "نجمة": 1, "نجمه": 1,
    "lightning": 1, "برق": 1, "صاعقة": 1,
    "weights": 1, "أثقال": 1,
    "coffee": 1, "قهوة": 1,
    "greeting": 1, "تحية": 1,
    "thumbs up": 1, "إعجاب": 1,

    # 2 - 9 Diamonds
    "finger heart": 5, "حركة القلب": 5, "قلب باليد": 5, "قلب صغير": 5,
    "panda": 5, "باندا": 5,
    "mic": 5, "ميكروفون": 5, "مايك": 5,
    "hi": 5, "مرحبا": 5, "هلا": 5,
    "love you": 5, "أحبك": 5,
    "cotton candy": 5, "غزل البنات": 5,
    "hand heart": 9, "قلب يدوي": 9,

    # 10 - 49 Diamonds
    "gamepad": 10, "ذراع ألعاب": 10,
    "perfume": 20, "عطر": 20,
    "doughnut": 30, "donut": 30, "دونات": 30,
    "leon the kitten": 34, "قط ليون": 34, "ليون": 34,

    # 50 - 99 Diamonds
    "butterfly": 88, "فراشة": 88,
    "paper crane": 99, "طائر ورقي": 99,
    "cap and mustache": 99, "قبعة وشارب": 99, "شنب": 99,
    "little crown": 99, "تاج صغير": 99,
    "hat and mustache": 99,

    # 100 - 499 Diamonds
    "confetti": 100, "قصاصات": 100, "احتفال": 100,
    "hand hearts": 100, "قلوب اليد": 100,
    "bear": 100, "دب": 100,
    "origami gun": 100, "مسدس ورقي": 100,
    "sunglasses": 199, "glasses": 199, "نظارات شمسية": 199, "نظارة": 199, "نظارات": 199,
    "love bang": 199, "قنبلة الحب": 199,
    "goggles": 199,
    "corgi": 299, "كورجي": 299, "كلب": 299,
    "duck": 299, "بطة": 299,
    "boxing gloves": 299, "gloves": 299, "قفازات ملاكمة": 299, "قفاز": 299, "قفازات": 299,

    # 500 - 999 Diamonds
    "swan": 699, "بجعة": 699,
    "train": 899, "قطار": 899,
    "trophy": 999, "كأس": 999,

    # 1000 - 4999 Diamonds (Big Gifts)
    "fireworks": 1088, "ألعاب نارية": 1088,
    "diamond": 1000, "ألماسة": 1000,
    "whale diving": 2150, "diving whale": 2150, "حوت غاطس": 2150, "حوت": 2150,
    "motorcycle": 2988, "دراجة نارية": 2988, "موتوسيكل": 2988,
    "private jet": 4888, "jet": 4888, "طائرة خاصة": 4888, "طائرة": 4888, "طيارة": 4888,

    # 5000 - 19999 Diamonds (Mega Gifts)
    "magic mirror": 5000, "مرآة سحرية": 5000,
    "sports car": 7000, "سيارة رياضية": 7000, "سيارة": 7000,
    "yacht": 9888, "luxury yacht": 9888, "يخت": 9888,
    "interstellar": 10000, "galaxy": 10000, "مجرة": 10000, "فضاء": 10000, "بين النجوم": 10000, "غالاكسي": 10000,
    "falcon": 10999, "صقر": 10999,
    "planet": 15000, "كوكب": 15000,
    "castle": 20000, "قلعة": 20000,
    "tiktok shuttle": 20000, "shuttle": 20000, "مكوك تيك توك": 20000, "مكوك": 20000,
    "level ship": 21000, "سفينة": 21000,

    # 20000+ Diamonds (Super Legendary Gifts)
    "phoenix": 25999, "عنقاء": 25999,
    "dragon": 26999, "تنين": 26999,
    "lion": 29999, "أسد": 29999,
    "zeus": 34000, "زيوس": 34000,
    "tiktok universe": 34999, "universe": 34999, "كون تيك توك": 34999, "عالم تيك توك": 34999, "يونيفيرس": 34999,
    "pegasus": 39999, "بيغاسوس": 39999, "حصان مجنح": 39999,
    "adam": 40000, "آدم": 40000,
    "seal": 50000, "ختم": 50000,
}

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
            self._gift_count = 0
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
                "duration": 300,
                "start_time": 0.0,
                "remaining_seconds": 300,
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

        def update_supporter_score(
            self, uid, uniq, nick, av, score: int,
            is_hidden: bool = False, is_unmasked: bool = False,
            revealed_username: str = "", revealed_nickname: str = "", revealed_avatar: str = ""
        ) -> None:
            if not uid:
                return
            sup = self._supporters.setdefault(uid, {
                "user_id": uid, "unique_id": uniq, "nickname": nick,
                "avatar_url": av, "total_diamonds": 0, "gift_count": 0,
                "is_hidden": is_hidden, "is_unmasked": is_unmasked,
                "revealed_username": revealed_username,
                "revealed_nickname": revealed_nickname,
                "revealed_avatar": revealed_avatar,
            })
            sup["total_diamonds"] = max(sup["total_diamonds"], score)
            if is_hidden:
                sup["is_hidden"] = True
            if is_unmasked:
                sup["is_unmasked"] = True
                if revealed_username: sup["revealed_username"] = revealed_username
                if revealed_nickname: sup["revealed_nickname"] = revealed_nickname
                if revealed_avatar: sup["revealed_avatar"] = revealed_avatar

        def unmask_supporter(self, uid: str, uniq: str, nick: str, av: str = "") -> None:
            """Unmask a previously hidden supporter when their true identity is discovered."""
            if not uid or uid not in self._supporters:
                return
            sup = self._supporters[uid]
            sup["is_unmasked"] = True
            sup["revealed_username"] = uniq
            sup["revealed_nickname"] = nick or uniq
            if av and not sup.get("revealed_avatar"):
                sup["revealed_avatar"] = av

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

        def process_gift(
            self, uid, uniq, nick, av, gid, gname, gicon, udiam, rc, streak,
            is_hidden: bool = False, is_unmasked: bool = False,
            revealed_username: str = "", revealed_nickname: str = "", revealed_avatar: str = ""
        ):
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
                "is_hidden": is_hidden, "is_unmasked": is_unmasked,
                "revealed_username": revealed_username,
                "revealed_nickname": revealed_nickname,
                "revealed_avatar": revealed_avatar,
            })
            sup["total_diamonds"] += val
            if is_hidden:
                sup["is_hidden"] = True
            if is_unmasked:
                sup["is_unmasked"] = True
                if revealed_username: sup["revealed_username"] = revealed_username
                if revealed_nickname: sup["revealed_nickname"] = revealed_nickname
                if revealed_avatar: sup["revealed_avatar"] = revealed_avatar

            if delta > 0:
                sup["gift_count"] += 1
                self._gift_count += max(1, delta)

            txn = {
                "gift_id": gid, "gift_name": gname, "gift_icon_url": gicon,
                "diamond_unit_cost": udiam, "repeat_count": rc,
                "is_streak_ending": not streak, "total_value": val,
                "combo_diamonds": udiam * rc,
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
            duration: int | None = None,
            start_time: float | None = None,
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

            # Battle timing logic
            if active and not was_active:
                cur_start = start_time or time.time()
            elif active and start_time:
                cur_start = start_time
            elif active:
                cur_start = self._pk.get("start_time", 0.0) or time.time()
            else:
                cur_start = 0.0

            cur_dur = duration if (duration and duration > 0) else self._pk.get("duration", 300)
            rem_sec = max(0, int(cur_dur - (time.time() - cur_start))) if (active and cur_start > 0) else 0

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
                "duration": cur_dur,
                "start_time": cur_start,
                "remaining_seconds": rem_sec,
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
        def get_total_gifts(self)    -> int: return self._gift_count

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
                "total_gifts":      self._gift_count,
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


def _extract_gift_icon(gift, event=None) -> str:
    """Extract gift icon URL safely from any gift or event structure."""
    if not gift and not event:
        return ""
    if event:
        for attr in ("gift_icon_image", "gift_image", "icon"):
            sub = _safe(event, attr)
            if sub:
                av = _extract_avatar(sub)
                if av:
                    return av
    if gift:
        if isinstance(gift, str) and gift.startswith("http"):
            return gift
        for attr in ("image", "icon", "gift_icon_image", "gift_image"):
            sub = _safe(gift, attr)
            if sub:
                av = _extract_avatar(sub)
                if av:
                    return av
        urls = _safe(gift, "url_list")
        if urls and isinstance(urls, (list, tuple)) and len(urls) > 0:
            return str(urls[0])
    return ""


def _is_hidden_user(user_id: str, unique_id: str, nickname: str, event_or_user=None) -> bool:
    """
    Detect if a user or gift supporter is masked, anonymous, or incognito.
    Detects Arabic/English masked strings, asterisk obfuscation, and incognito flags.
    """
    if not user_id or str(user_id) == "0":
        return True

    # Check explicit incognito flags in event or user object
    if event_or_user is not None:
        for attr in ("is_anonymous", "anonymous", "is_stealth", "is_incognito", "stealth_mode"):
            val = _safe(event_or_user, attr, default=False)
            if bool(val):
                return True

    nick_clean = (nickname or "").strip().lower()
    uniq_clean = (unique_id or "").strip().lower()

    # Empty nickname or unique_id
    if not nick_clean and not uniq_clean:
        return True

    # Known masked patterns in Arabic and English
    masked_patterns = (
        "مستخدم tiktok", "tiktok user", "tiktok_user", "مستخدم تيك توك",
        "مستخدم", "مخفي", "مجهول", "فاعل خير", "داعم مخفي", "anonymous",
        "incognito", "hidden", "user_", "tiktokuser", "ghost",
    )
    if any(p == nick_clean or nick_clean.startswith(p) for p in masked_patterns):
        return True
    if any(p == uniq_clean or uniq_clean.startswith(p) for p in masked_patterns):
        return True

    # Asterisk masking (e.g. "a***d" or "***")
    if "***" in nick_clean or "***" in uniq_clean:
        return True

    return False


def _extract_stream_video_urls(room_info: dict, username: str) -> dict:
    """
    Extract HLS (.m3u8), FLV, and web URLs from TikTok room_info.
    Parses both direct pull URLs and nested live_core_sdk_data stream_data JSON.
    """
    res = {
        "hls_url": "",
        "best_hls_url": "",
        "flv_url": "",
        "web_url": f"https://www.tiktok.com/@{username}/live",
        "embed_url": "",
        "iframe_url": "",
        "room_id": "",
        "qualities": {},
        "has_video": False,
    }
    if not room_info or not isinstance(room_info, dict):
        return res

    stream_url = room_info.get("stream_url") or {}
    if not isinstance(stream_url, dict):
        stream_url = {}

    # 1. Direct pull URLs
    hls_direct = str(stream_url.get("hls_pull_url") or "")
    flv_direct = str(stream_url.get("flv_pull_url") or stream_url.get("rtmp_pull_url") or "")

    # 2. Extract from hls_pull_url_map & flv_pull_url_map if present
    hls_map = stream_url.get("hls_pull_url_map") or {}
    if isinstance(hls_map, dict):
        for k, v in hls_map.items():
            if v and isinstance(v, str):
                qk = k.lower().replace("_", "")
                res["qualities"].setdefault(qk, {})["hls"] = v

    flv_map = stream_url.get("flv_pull_url_map") or {}
    if isinstance(flv_map, dict):
        for k, v in flv_map.items():
            if v and isinstance(v, str):
                qk = k.lower().replace("_", "")
                res["qualities"].setdefault(qk, {})["flv"] = v

    # 3. Extract from live_core_sdk_data / pull_data / stream_data JSON
    try:
        sdk_data = stream_url.get("live_core_sdk_data") or {}
        pull_data = sdk_data.get("pull_data") or stream_url.get("pull_data") or {}
        if isinstance(pull_data, str):
            try:
                pull_data = json.loads(pull_data)
            except Exception:
                pull_data = {}

        stream_data_str = pull_data.get("stream_data") or ""
        if stream_data_str and isinstance(stream_data_str, str):
            try:
                stream_data = json.loads(stream_data_str)
                data_map = stream_data.get("data", {})
                for q in ("origin", "uhd", "hd", "sd", "ld"):
                    if q in data_map:
                        main = data_map[q].get("main", {})
                        hls = str(main.get("hls", ""))
                        flv = str(main.get("flv", "") or main.get("cmaf", ""))
                        if hls or flv:
                            res["qualities"].setdefault(q, {})
                            if hls:
                                res["qualities"][q]["hls"] = hls
                            if flv:
                                res["qualities"][q]["flv"] = flv
            except Exception as e:
                logger.debug("Error parsing stream_data JSON: %s", e)
    except Exception as e:
        logger.debug("Error extracting pull_data: %s", e)

    # 4. Choose best HLS URL for ultra-smooth live playback:
    # Prefer 'hd' (smooth 720p) or 'sd' (smooth 540p) over heavy 4K/1080p 'origin' to prevent stuttering
    qualities = res["qualities"]
    best_hls = ""
    for pref in ("hd", "sd", "origin", "uhd", "ld"):
        if pref in qualities and qualities[pref].get("hls"):
            best_hls = qualities[pref]["hls"]
            break

    if not best_hls and hls_direct:
        best_hls = hls_direct
    if not best_hls:
        for qinfo in qualities.values():
            if qinfo.get("hls"):
                best_hls = qinfo["hls"]
                break

    res["hls_url"] = best_hls
    res["best_hls_url"] = best_hls

    # Fallback FLV
    if not res["flv_url"] and flv_direct:
        res["flv_url"] = flv_direct
    if not res["flv_url"]:
        for qinfo in qualities.values():
            if qinfo.get("flv"):
                res["flv_url"] = qinfo["flv"]
                break

    room_id = str(room_info.get("id") or room_info.get("room_id") or "")
    if room_id:
        res["room_id"] = room_id
        res["embed_url"] = f"https://www.tiktok.com/player/v1/live?room_id={room_id}&autoplay=1"
        res["iframe_url"] = f"https://www.tiktok.com/embed/v2/live/{room_id}"

    if res["hls_url"] or res["flv_url"] or res["embed_url"]:
        res["has_video"] = True

    return res


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
        self._is_connected       = False
        self._room_id            = ""
        self._streamer_user_id   = ""
        self._streamer_unique_id = ""
        self._streamer_nickname  = ""
        self._streamer_avatar    = ""
        self._gift_catalog: dict[str, dict] = {}
        self._gift_catalog_by_name: dict[str, dict] = {}
        self._user_identities: dict[str, dict] = {}
        self._stream_video_data: dict = {}

    def resolve_supporter_identity(self, uinfo: dict, event=None) -> dict:
        """
        Detect if a supporter is masked or hidden.
        If hidden, cross-reference their persistent numeric user_id with known
        room commenters/likers, or display_id to reveal their true username and nickname.
        """
        uid = str(uinfo.get("user_id", "") or "")
        uniq = str(uinfo.get("unique_id", "") or "")
        nick = str(uinfo.get("nickname", "") or "")
        av = str(uinfo.get("avatar_url", "") or "")

        is_hidden = _is_hidden_user(uid, uniq, nick, event)
        is_unmasked = False
        revealed_username = ""
        revealed_nickname = ""
        revealed_avatar = ""

        if is_hidden:
            # Check 1: Does unique_id or display_id contain a real handle?
            if uniq and not _is_hidden_user(uid, uniq, uniq, None):
                is_unmasked = True
                revealed_username = uniq
                revealed_nickname = nick if (nick and not _is_hidden_user(uid, "", nick, None)) else uniq
                revealed_avatar = av
            # Check 2: Check persistent room identity registry for this user_id
            elif uid and uid in self._user_identities:
                cached = self._user_identities[uid]
                c_uniq = cached.get("unique_id", "")
                c_nick = cached.get("nickname", "")
                if c_uniq and not _is_hidden_user(uid, c_uniq, c_nick, None):
                    is_unmasked = True
                    revealed_username = c_uniq
                    revealed_nickname = c_nick or c_uniq
                    revealed_avatar = cached.get("avatar_url", "") or av

            # If still not unmasked, provide system short ID badge
            if not is_unmasked:
                short_id = uid[-6:] if len(uid) >= 6 else (uid or "anon")
                revealed_username = f"user_{short_id}"
                revealed_nickname = f"داعم مخفي #{short_id}"
                revealed_avatar = av
        else:
            # User is public: record in identity registry for future cross-referencing
            if uid and uid != "0" and uniq:
                self._user_identities[uid] = {
                    "user_id": uid,
                    "unique_id": uniq,
                    "nickname": nick or uniq,
                    "avatar_url": av,
                }

        return {
            "is_hidden": is_hidden,
            "is_unmasked": is_unmasked,
            "revealed_username": revealed_username,
            "revealed_nickname": revealed_nickname,
            "revealed_avatar": revealed_avatar,
        }

    def check_and_unmask_existing_supporter(self, uid: str, uniq: str, nick: str, av: str = "") -> None:
        """
        Record genuine user identity from comments/likes/ranks,
        and automatically unmask any existing supporter in the engine.
        """
        if not uid or uid == "0":
            return
        if _is_hidden_user(uid, uniq, nick, None):
            return

        self._user_identities[uid] = {
            "user_id": uid,
            "unique_id": uniq,
            "nickname": nick or uniq,
            "avatar_url": av,
        }
        if hasattr(self._engine, "unmask_supporter"):
            self._engine.unmask_supporter(uid, uniq, nick or uniq, av)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def is_connected(self) -> bool:
        return self._is_connected

    @property
    def room_id(self) -> str:
        return self._room_id

    async def start(self) -> None:
        """Connect to the TikTok Live room and start event processing."""
        if self._running:
            return
        self._running = True
        self._engine.reset()

        self._client = TikTokLiveClient(unique_id=self.username)
        self._register_handlers()

        # Run client in a background task so we don't block the WS loop
        self._task = asyncio.create_task(
            self._run_client(), name=f"tiktok-{self.username}"
        )

    async def stop(self) -> None:
        """Gracefully stop the tracking session."""
        self._running = False
        self._is_connected = False
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

    def get_snapshot_payload(self) -> dict:
        """Return the current dashboard snapshot formatted as a WebSocket payload."""
        snap = self._engine.get_dashboard_snapshot()
        data = snap.to_dict() if hasattr(snap, "to_dict") else snap

        # Enrich computed fields
        data["total_coins"]    = data.get("total_diamonds", 0)
        data["total_gifts"]    = getattr(self._engine, "get_total_gifts", lambda: 0)()
        data["estimated_usd"]  = round(
            data.get("total_diamonds", 0) * DIAMOND_TO_USD_RATE, 4
        )
        data["net_payout_usd"] = round(
            data.get("estimated_usd", 0.0) * NET_PAYOUT_RATIO, 4
        )
        data["stream_video"]   = getattr(self, "_stream_video_data", None) or _extract_stream_video_urls({}, self.username)
        return {"type": "snapshot", "data": data}

    async def send_snapshot(self) -> None:
        """Push the current dashboard snapshot to the WebSocket client."""
        await self._send(self.get_snapshot_payload())

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    async def _run_client(self) -> None:
        max_retries = 3
        retry_count = 0
        backoff = 3

        # Connect directly to TikTok Live room — TikTokLive handles HTML scraping,
        # room resolution, and raises UserOfflineError / UserNotFoundError accurately.
        while self._running:
            try:
                logger.info("Connecting to @%s (retry %d/%d)...", self.username, retry_count, max_retries)
                await self._client.connect(
                    process_connect_events=True,
                    fetch_room_info=True,
                    fetch_gift_info=True,
                )

                if not self._running:
                    break

                # If connect() completes cleanly while self._running is True, the stream ended
                logger.info("Live stream ended for @%s", self.username)
                await self._send({
                    "type": "disconnected",
                    "username": self.username,
                    "message": f"انتهى البث المباشر للحساب @{self.username}",
                })
                break

            except asyncio.CancelledError:
                break

            except UserOfflineError:
                logger.info("@%s is offline.", self.username)
                await self._send({
                    "type": "error",
                    "code": "USER_OFFLINE",
                    "message": "الحساب ليس في بث مباشر حالياً",
                    "detail": f"صاحب الحساب @{self.username} ليس في بث مباشر (LIVE) الآن. يرجى التأكد من أن صاحب الحساب يبث حالياً.",
                })
                break

            except UserNotFoundError:
                logger.info("@%s not found.", self.username)
                await self._send({
                    "type": "error",
                    "code": "USER_NOT_FOUND",
                    "message": "الحساب غير موجود",
                    "detail": f"لم يتم العثور على الحساب @{self.username} على تيك توك. يرجى التأكد من كتابة اسم المعرف الفريد الإنجليزي (@username المكتوب تحت الصورة الشخصية) وليس الاسم المعروض.",
                })
                break

            except (SignatureRateLimitError, SignAPIError) as exc:
                err_str = str(exc)
                logger.warning("Sign error for @%s: %s", self.username, err_str)
                is_rate_limit = "rate_limit" in err_str.lower() or "too many connections" in err_str.lower()
                await self._send({
                    "type": "error",
                    "code": "RATE_LIMIT" if is_rate_limit else "SIGN_ERROR",
                    "message": "حد مزود التوقيع السحابي (EulerStream Rate Limit)" if is_rate_limit else "خطأ في مزود التوقيع",
                    "detail": (
                        "تم تجاوز عدد الاتصالات على الـ IP المشترك لمزود التوقيع (EulerStream). "
                        "يرجى الحصول على مفتاح API مجاني (SIGN_API_KEY) من موقع eulerstream.com وإضافته في لوحة الأدمن."
                    ) if is_rate_limit else f"تعذر استكمال التوقيع: {err_str}",
                })
                break

            except Exception as exc:
                if not self._running:
                    break
                err_str = str(exc)
                err_lower = err_str.lower()
                logger.warning("TikTokLive error for @%s: %s", self.username, err_str)

                if "not capable of going live" in err_lower or "never gone live" in err_lower:
                    await self._send({
                        "type": "error",
                        "code": "USER_NOT_LIVE_CAPABLE",
                        "message": "الحساب غير مؤهل للبث المباشر أو غير موجود",
                        "detail": f"الحساب @{self.username} لم يسبق له البث المباشر على تيك توك أو غير متاح. تأكد من إدخال اسم المعرف الإنجليزي وليس الاسم المعروض.",
                    })
                    break

                if "rate_limit" in err_lower or "eulerstream" in err_lower:
                    await self._send({
                        "type": "error",
                        "code": "RATE_LIMIT",
                        "message": "تم بلوغ الحد المسموح للتوقيع (Sign Rate Limit)",
                        "detail": "تم تجاوز حد التوقيع المجاني من EulerStream. يرجى توفير SIGN_API_KEY مجاني من eulerstream.com في لوحة الأدمن.",
                    })
                    break

                if "offline" in err_lower:
                    await self._send({
                        "type": "error",
                        "code": "USER_OFFLINE",
                        "message": "الحساب ليس في بث مباشر حالياً",
                        "detail": f"المستخدم @{self.username} غير متصل ببث مباشر الآن.",
                    })
                    break

                # Transient network or stream glitch: retry up to max_retries
                if retry_count < max_retries:
                    retry_count += 1
                    logger.info("Retrying @%s (%d/%d) in %ds...", self.username, retry_count, max_retries, backoff)
                    await self._send({
                        "type": "reconnecting",
                        "username": self.username,
                        "retry_count": retry_count,
                        "max_retries": max_retries,
                        "message": f"انقطع الاتصال مؤقتاً. جاري إعادة المحاولة ({retry_count}/{max_retries})...",
                    })
                    await asyncio.sleep(backoff)
                    backoff = min(backoff + 2, 10)
                    self._client = TikTokLiveClient(unique_id=self.username)
                    self._register_handlers()
                else:
                    await self._send({
                        "type": "error",
                        "code": "CONNECTION_FAILED",
                        "message": "تعذر الاتصال بالبث المباشر",
                        "detail": f"فشلت محاولات الاتصال بحساب @{self.username} ({err_str}).",
                    })
                    break

        self._running = False

    def _register_handlers(self) -> None:
        client = self._client

        # ---- Connect ----
        @client.on(ConnectEvent)
        async def on_connect(event: ConnectEvent):
            self._is_connected = True
            self._room_id = str(event.room_id)
            logger.info("Connected to @%s (room_id=%s)", self.username, event.room_id)
            await self._send({
                "type":     "connected",
                "username": self.username,
                "room_id":  str(event.room_id),
            })

            # Fetch initial room info safely
            try:
                r_info = client.room_info or await client._web.fetch_room_info(room_id=event.room_id)
                if r_info and isinstance(r_info, dict):
                    owner = r_info.get("owner", {}) or {}
                    if owner:
                        self._streamer_user_id   = str(owner.get("id", "") or owner.get("id_str", ""))
                        self._streamer_unique_id = str(owner.get("display_id", "") or self.username)
                        self._streamer_nickname  = str(owner.get("nickname", "") or self.username)
                        self._streamer_avatar    = _extract_avatar(owner)

                    stats = r_info.get("stats") or {}
                    room_view_stats = r_info.get("room_view_stats") or {}

                    init_likes = int(
                        r_info.get("like_count") or
                        stats.get("like_count") or
                        stats.get("total_like_count") or
                        stats.get("digg_count") or
                        0
                    )
                    if init_likes > 0:
                        self._engine.set_total_likes(init_likes)

                    init_viewers = int(
                        r_info.get("user_count") or
                        stats.get("user_count") or
                        stats.get("total_user") or
                        r_info.get("total_user") or
                        0
                    )
                    if init_viewers > 0:
                        self._engine.update_viewer_count(init_viewers)

                    # Exhaustive search for cumulative stream diamonds since start
                    init_diamonds = 0
                    for candidate in [
                        r_info.get("fan_ticket_count"),
                        stats.get("fan_ticket_count"),
                        stats.get("total_diamonds"),
                        stats.get("total_diamond_count"),
                        room_view_stats.get("fan_ticket_count"),
                        owner.get("fan_ticket_count"),
                        r_info.get("total_fan_ticket_count"),
                    ]:
                        if candidate is not None and str(candidate).isdigit():
                            init_diamonds = max(init_diamonds, int(candidate))

                    if init_diamonds > 0:
                        self._engine.set_total_diamonds(init_diamonds)
                        logger.info("Initialized @%s with %d total diamonds since live opened", self.username, init_diamonds)

                    # Initial top supporters if available in room info
                    ranks = r_info.get("top_fans") or r_info.get("ranks") or stats.get("top_fans") or []
                    if ranks and isinstance(ranks, (list, tuple)):
                        for contributor in ranks:
                            c_user = contributor.get("user") or contributor
                            c_uid = str(c_user.get("id") or c_user.get("id_str") or "")
                            c_uniq = str(c_user.get("display_id") or c_user.get("unique_id") or "")
                            c_nick = str(c_user.get("nickname") or c_uniq or "داعم")
                            c_av = _extract_avatar(c_user)
                            c_score = int(contributor.get("fan_ticket") or contributor.get("score") or 0)
                            if c_score > 0 and c_uid:
                                id_res = self.resolve_supporter_identity({
                                    "user_id": c_uid, "unique_id": c_uniq,
                                    "nickname": c_nick, "avatar_url": c_av,
                                })
                                self._engine.update_supporter_score(
                                    c_uid, c_uniq, c_nick, c_av, c_score,
                                    is_hidden=id_res["is_hidden"],
                                    is_unmasked=id_res["is_unmasked"],
                                    revealed_username=id_res["revealed_username"],
                                    revealed_nickname=id_res["revealed_nickname"],
                                    revealed_avatar=id_res["revealed_avatar"],
                                )

                    # Check if stream is ALREADY in an active battle upon connection!
                    link_mic = r_info.get("link_mic") or r_info.get("linkmic_info") or r_info.get("battle_info") or {}
                    if link_mic and isinstance(link_mic, dict):
                        b_id = str(link_mic.get("battle_id", "") or "")
                        if b_id:
                            logger.info("Stream @%s is currently in an active PK battle (%s) on connect", self.username, b_id)
                            self._engine.update_pk_battle(
                                bid=b_id,
                                active=True,
                                status="ACTIVE",
                            )

                    # Extract stream video URLs (HLS / FLV / web) and broadcast to frontend
                    self._stream_video_data = _extract_stream_video_urls(r_info, self.username)
                    await self._send({
                        "type": "stream_video",
                        "data": self._stream_video_data,
                    })
                    logger.info("Extracted stream video for @%s (has_video=%s)", self.username, self._stream_video_data.get("has_video"))
            except Exception as e:
                logger.debug("Optional initial room_info fetch: %s", e)

            # Preload full TikTok gift catalog (700+ gifts with exact diamond prices and icons)
            try:
                gift_res = await client._web.fetch_gift_list(event.room_id)
                if gift_res and isinstance(gift_res, dict):
                    raw_gifts = gift_res.get("gifts", [])
                    for g in raw_gifts:
                        gid = str(g.get("id", ""))
                        gname = str(g.get("name", "")).strip()
                        if gid:
                            img_obj = g.get("image") or g.get("icon")
                            icon_url = ""
                            if isinstance(img_obj, dict):
                                urls = img_obj.get("url_list", [])
                                if urls and len(urls) > 0:
                                    icon_url = urls[0]
                            entry = {
                                "id": gid,
                                "name": gname,
                                "diamond_count": int(g.get("diamond_count", 0) or 0),
                                "icon_url": icon_url,
                            }
                            self._gift_catalog[gid] = entry
                            if gname:
                                self._gift_catalog_by_name[gname.lower()] = entry
                    logger.info("Loaded %d official TikTok gifts into catalog for @%s", len(self._gift_catalog), self.username)
            except Exception as e:
                logger.debug("Optional gift list fetch error: %s", e)

            await self.send_snapshot()

        # ---- Disconnect ----
        @client.on(DisconnectEvent)
        async def on_disconnect(event: DisconnectEvent):
            self._is_connected = False
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
            contributors_total = 0
            if ranks and isinstance(ranks, (list, tuple)):
                for contributor in ranks:
                    c_user = _safe(contributor, "user")
                    if c_user:
                        c_uinfo = _user_info(c_user)
                        c_score = int(_safe(contributor, "score", default=0))
                        if c_score > 0 and c_uinfo["user_id"]:
                            contributors_total += c_score
                            id_res = self.resolve_supporter_identity(c_uinfo)
                            self._engine.update_supporter_score(
                                c_uinfo["user_id"], c_uinfo["unique_id"],
                                c_uinfo["nickname"], c_uinfo["avatar_url"],
                                c_score,
                                is_hidden=id_res["is_hidden"],
                                is_unmasked=id_res["is_unmasked"],
                                revealed_username=id_res["revealed_username"],
                                revealed_nickname=id_res["revealed_nickname"],
                                revealed_avatar=id_res["revealed_avatar"],
                            )

            if contributors_total > 0:
                self._engine.set_total_diamonds(contributors_total)

            supporters = self._engine.get_top_supporters(10)
            leaderboard = [
                (s.to_dict() if hasattr(s, "to_dict") else s)
                for s in supporters
            ]

            total_diamonds = self._engine.get_total_diamonds()
            estimated_usd  = round(total_diamonds * DIAMOND_TO_USD_RATE, 4)
            net_payout     = round(estimated_usd * NET_PAYOUT_RATIO, 4)

            await self._send({
                "type": "viewers",
                "data": {
                    "viewer_count":   getattr(self._engine, "_viewers", viewers),
                    "total_diamonds": total_diamonds,
                    "estimated_usd":  estimated_usd,
                    "net_payout_usd": net_payout,
                },
                "leaderboard": leaderboard,
            })

        # ---- Comments ----
        @client.on(CommentEvent)
        async def on_comment(event: CommentEvent):
            user  = _safe(event, "user")
            uinfo = _user_info(user)

            # Auto-unmask: if this user was previously a hidden supporter, reveal their identity!
            self.check_and_unmask_existing_supporter(
                uinfo["user_id"], uinfo["unique_id"], uinfo["nickname"], uinfo["avatar_url"]
            )

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

            # Auto-unmask from likes
            self.check_and_unmask_existing_supporter(
                uinfo["user_id"], uinfo["unique_id"], uinfo["nickname"], uinfo["avatar_url"]
            )

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

            # Identity & Hidden Supporter Resolution
            identity = self.resolve_supporter_identity(uinfo, event)
            is_hidden = identity["is_hidden"]
            is_unmasked = identity["is_unmasked"]
            revealed_username = identity["revealed_username"]
            revealed_nickname = identity["revealed_nickname"]
            revealed_avatar = identity["revealed_avatar"]

            gift      = _safe(event, "gift")
            gift_id   = str(_safe(event, "gift_id", default=0) or _safe(gift, "id", default="0"))
            gift_name = str(_safe(gift, "name", default="Unknown Gift"))
            gift_icon = _extract_gift_icon(gift, event)

            unit_diamonds = int(
                _safe(gift, "diamond_count", default=0) or
                _safe(gift, "coins", default=0) or
                _safe(event, "fan_ticket_count", default=0) or
                _safe(gift, "diamond_icon_count", default=0) or
                0
            )

            # Fallback to preloaded official TikTok catalog if diamond_count or name is missing
            cached_gift = self._gift_catalog.get(gift_id, {})
            if not cached_gift and gift_name:
                cached_gift = self._gift_catalog_by_name.get(gift_name.lower().strip(), {})

            if unit_diamonds <= 0 and cached_gift:
                unit_diamonds = cached_gift.get("diamond_count", 0)
            if (gift_name in ("Unknown Gift", "", "None") or not gift_name) and cached_gift:
                gift_name = cached_gift.get("name", gift_name)
            if not gift_icon and cached_gift:
                gift_icon = cached_gift.get("icon_url", "")

            # Static fallback for top known TikTok gifts in English and Arabic
            if unit_diamonds <= 0 and gift_name:
                clean_name = gift_name.lower().strip()
                unit_diamonds = COMMON_TIKTOK_GIFTS.get(clean_name, 0)
                if unit_diamonds <= 0:
                    for k, v in COMMON_TIKTOK_GIFTS.items():
                        if k in clean_name:
                            unit_diamonds = v
                            break

            # Absolute fallback minimum 1 diamond so no gift is ever zero diamonds
            if unit_diamonds <= 0:
                unit_diamonds = 1

            repeat_count  = int(_safe(event, "repeat_count", default=1) or 1)
            repeat_end    = int(_safe(event, "repeat_end", default=0))
            streak_active = (repeat_end == 0)

            combo_diamonds = unit_diamonds * repeat_count
            combo_usd = round(combo_diamonds * DIAMOND_TO_USD_RATE, 2)

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
                is_hidden=is_hidden, is_unmasked=is_unmasked,
                revealed_username=revealed_username,
                revealed_nickname=revealed_nickname,
                revealed_avatar=revealed_avatar,
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
                    "user":              uinfo,
                    "transaction":       txn_dict,
                    "streak_active":     streak_active,
                    "repeat_count":      repeat_count,
                    "diamond_unit_cost": unit_diamonds,
                    "combo_diamonds":    combo_diamonds,
                    "combo_usd":         combo_usd,
                    "total_diamonds":    total_diamonds,
                    "total_gifts":       getattr(self._engine, "get_total_gifts", lambda: 0)(),
                    "estimated_usd":     estimated_usd,
                    "net_payout_usd":    net_payout,
                    "recipient_side":    recipient_side,
                    "recipient_name":    recipient_name,
                    "is_battle_gift":    is_pk,
                    "is_hidden":         is_hidden,
                    "is_unmasked":       is_unmasked,
                    "revealed_username": revealed_username,
                    "revealed_nickname": revealed_nickname,
                    "revealed_avatar":   revealed_avatar,
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
                event_tag = "start"
            elif act == 5 or "FINISH" in act_str or act_str == "5":
                status = "PUNISH"
                is_active = True
                event_tag = "punish"
            elif act in (3, 6, 11) or any(x in act_str for x in ("CANCEL", "CUT_SHORT", "LEAVE")):
                status = "ENDED"
                is_active = False
                event_tag = "ended"
            else:
                status = "ACTIVE" if battle_id else "IDLE"
                is_active = bool(battle_id)
                event_tag = "update" if is_active else "ended"

            host_name = host_anchors[0].get("unique_id", self.username) if host_anchors else self.username
            opp_name  = opp_anchors[0].get("unique_id", "opponent") if opp_anchors else "opponent"

            duration = int(_safe(event, "duration", default=0) or _safe(_safe(event, "battle_settings"), "duration", default=0) or 300)
            if duration <= 0:
                duration = 300

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
                duration=duration,
            )

            pk = self._engine.get_pk_state()
            pk_dict = pk.to_dict() if hasattr(pk, "to_dict") else pk.__dict__
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
            if gift_id > 0 and from_uid != "0":
                cached_pk_gift = self._gift_catalog.get(str(gift_id), {})
                if diam_count <= 0 and cached_pk_gift:
                    diam_count = cached_pk_gift.get("diamond_count", 0)
                pk_gift_name = cached_pk_gift.get("name", "PK Battle Gift") if cached_pk_gift else "PK Battle Gift"
                gift_icon = _extract_avatar(_safe(event, "gift_icon_image")) or (cached_pk_gift.get("icon_url", "") if cached_pk_gift else "")

                sender_nick = "داعـم"
                sender_av   = ""
                for c in (host_mvps + opp_mvps):
                    if c.get("user_id") == from_uid:
                        sender_nick = c.get("nickname") or "داعـم"
                        sender_av   = c.get("avatar_url") or ""
                        break
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
                            "gift_name": pk_gift_name,
                            "gift_icon_url": gift_icon,
                            "diamond_unit_cost": diam_count,
                            "repeat_count": int(_safe(event, "repeat_count", default=1) or 1),
                            "is_streak_ending": True,
                            "total_value": diam_count,
                        },
                        "streak_active": False,
                        "repeat_count": int(_safe(event, "repeat_count", default=1) or 1),
                        "diamond_unit_cost": diam_count,
                        "combo_diamonds": diam_count,
                        "combo_usd": round(diam_count * DIAMOND_TO_USD_RATE, 2),
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

        # ---- PK Battle Item Cards (Boxing Gloves x5, Fog, Time boosters) ----
        if LinkMicBattleItemCardEvent:
            @client.on(LinkMicBattleItemCardEvent)
            async def on_pk_item_card(event: LinkMicBattleItemCardEvent):
                card_name = str(_safe(event, "card_name", default="") or "كرت الدعم")
                card_type = str(_safe(event, "card_type", default="glove"))
                desc = "تم تفعيل كرت مضاعفة النقاط في الجولة! 🔥" if "glove" in card_type.lower() or "boxing" in card_type.lower() else "تم تفعيل كرت داعم في الجولة ⚡"
                await self._send({
                    "type": "pk_item_card",
                    "data": {
                        "card_name": card_name or "كرت القفاز السحري 🥊",
                        "description": desc,
                    }
                })

        # ---- PK Fan Tickets Direct Sync ----
        if LinkMicFanTicketMethodEvent:
            @client.on(LinkMicFanTicketMethodEvent)
            async def on_pk_fan_ticket(event: LinkMicFanTicketMethodEvent):
                fan_tickets = int(_safe(event, "fan_ticket_count", default=0) or _safe(event, "total_fan_ticket_count", default=0))
                if fan_tickets > 0:
                    self._engine.set_total_diamonds(fan_tickets)

    async def _send(self, payload: dict) -> None:
        """Safely call the broadcast coroutine (swallows closed-socket errors)."""
        try:
            await self._broadcast(payload)
        except Exception as exc:
            logger.debug("WebSocket send error: %s", exc)
