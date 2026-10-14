# =============================================================================
#  backend/telegram_bot.py — Telegram Analytics Bot & Notification Service
# =============================================================================
import os
import json
import time
import html
import asyncio
import logging
from pathlib import Path
from typing import Callable, Any
import httpx

logger = logging.getLogger(__name__)

CONFIG_PATH = Path(__file__).parent / "telegram_config.json"


class TelegramBotManager:
    """
    Manages Telegram bot communications, automated statistical reports,
    event notifications, and interactive chat commands (/stats, /users, etc.).
    """

    def __init__(self, stats_provider: Callable[[], dict] | None = None) -> None:
        self.bot_token: str = ""
        self.chat_id: str = ""
        self.enabled: bool = False
        self.notify_on_new_stream: bool = True
        self.notify_on_stream_end: bool = True
        self.periodic_report_hours: int = 0  # 0 = disabled

        self._stats_provider: Callable[[], dict] | None = stats_provider
        self._polling_task: asyncio.Task | None = None
        self._periodic_task: asyncio.Task | None = None
        self._last_update_id: int = 0
        self._running: bool = False

        self.load_config()

    # -------------------------------------------------------------------------
    # Configuration Management
    # -------------------------------------------------------------------------

    def load_config(self) -> None:
        """Load configuration from JSON file or fall back to environment variables."""
        if CONFIG_PATH.exists():
            try:
                data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
                self.bot_token = data.get("bot_token", "").strip()
                self.chat_id = str(data.get("chat_id", "")).strip()
                self.enabled = bool(data.get("enabled", bool(self.bot_token and self.chat_id)))
                self.notify_on_new_stream = bool(data.get("notify_on_new_stream", True))
                self.notify_on_stream_end = bool(data.get("notify_on_stream_end", True))
                self.periodic_report_hours = int(data.get("periodic_report_hours", 0))
                logger.info("Telegram configuration loaded from %s", CONFIG_PATH)
                return
            except Exception as exc:
                logger.warning("Error reading telegram config: %s", exc)

        # Fallback to env vars
        self.bot_token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
        self.chat_id = os.getenv("TELEGRAM_CHAT_ID", "").strip()
        self.enabled = bool(self.bot_token and self.chat_id)
        self.notify_on_new_stream = True
        self.notify_on_stream_end = True
        self.periodic_report_hours = 0

    def save_config(self, data: dict) -> None:
        """Save configuration to JSON file and update live settings."""
        if "bot_token" in data:
            new_token = str(data.get("bot_token", "")).strip()
            # If user submitted a masked token like '1234...abcd', don't overwrite if unchanged
            if not ("..." in new_token and len(new_token) < 20):
                self.bot_token = new_token
        if "chat_id" in data:
            self.chat_id = str(data.get("chat_id", "")).strip()
        if "enabled" in data:
            self.enabled = bool(data.get("enabled", True))
        if "notify_on_new_stream" in data:
            self.notify_on_new_stream = bool(data.get("notify_on_new_stream", True))
        if "notify_on_stream_end" in data:
            self.notify_on_stream_end = bool(data.get("notify_on_stream_end", True))
        if "periodic_report_hours" in data:
            self.periodic_report_hours = max(0, int(data.get("periodic_report_hours", 0)))

        # Auto-disable if credentials missing
        if not self.bot_token or not self.chat_id:
            self.enabled = False

        save_payload = {
            "bot_token": self.bot_token,
            "chat_id": self.chat_id,
            "enabled": self.enabled,
            "notify_on_new_stream": self.notify_on_new_stream,
            "notify_on_stream_end": self.notify_on_stream_end,
            "periodic_report_hours": self.periodic_report_hours,
        }
        try:
            CONFIG_PATH.write_text(json.dumps(save_payload, indent=2, ensure_ascii=False), encoding="utf-8")
            logger.info("Telegram configuration saved.")
        except Exception as exc:
            logger.error("Failed to save telegram config: %s", exc)

    def get_safe_config(self) -> dict:
        """Return configuration with masked bot token for safe UI display."""
        masked_token = ""
        if self.bot_token:
            if len(self.bot_token) > 10:
                masked_token = f"{self.bot_token[:6]}...{self.bot_token[-4:]}"
            else:
                masked_token = "***"

        return {
            "bot_token_masked": masked_token,
            "has_token": bool(self.bot_token),
            "chat_id": self.chat_id,
            "enabled": self.enabled,
            "notify_on_new_stream": self.notify_on_new_stream,
            "notify_on_stream_end": self.notify_on_stream_end,
            "periodic_report_hours": self.periodic_report_hours,
            "is_running": self._running and bool(self._polling_task and not self._polling_task.done()),
        }

    # -------------------------------------------------------------------------
    # Telegram API Communication
    # -------------------------------------------------------------------------

    async def send_message(self, text: str, chat_id: str = "", parse_mode: str = "HTML") -> tuple[bool, str]:
        """Send a message to a Telegram chat via HTTP API."""
        token = self.bot_token
        target_chat = chat_id or self.chat_id

        if not token:
            return False, "لم يتم ضبط رمز البوت (TELEGRAM_BOT_TOKEN)"
        if not target_chat:
            return False, "لم يتم تحديد معرّف المحادثة (TELEGRAM_CHAT_ID)"

        url = f"https://api.telegram.org/bot{token}/sendMessage"
        payload = {
            "chat_id": target_chat,
            "text": text,
            "parse_mode": parse_mode,
            "disable_web_page_preview": True,
        }

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.post(url, json=payload)
                data = res.json()
                if res.status_code == 200 and data.get("ok"):
                    return True, "تم الإرسال بنجاح"
                else:
                    err_desc = data.get("description", res.text)
                    logger.warning("Telegram send failed (%d): %s", res.status_code, err_desc)
                    return False, f"فشل الإرسال: {err_desc}"
        except Exception as exc:
            logger.error("Telegram API connection error: %s", exc)
            return False, f"خطأ في الاتصال بتلغرام: {exc}"

    async def send_test_message(self) -> tuple[bool, str]:
        """Send an initial handshake/test message to confirm bot setup."""
        if not self.bot_token or not self.chat_id:
            return False, "يرجى إدخال رمز البوت (Bot Token) ومعرف المحادثة (Chat ID) أولاً."

        msg = (
            "🤖 <b>راصد تيك توك — اختبار الاتصال بنجاح</b>\n"
            "━━━━━━━━━━━━━━━━━━━━\n"
            "✅ تم ربط السيرفر مع بوت تلغرام بنجاح!\n"
            "📡 <b>الحالة:</b> نشط وجاهز لإرسال الإحصائيات والتنبيهات المباشرة.\n"
            "⏰ <b>الوقت:</b> " + time.strftime("%Y-%m-%d %H:%M:%S") + "\n\n"
            "💡 <i>يمكنك إرسال <b>/stats</b> إلى هذا البوت في أي وقت لطلب تقرير إحصائي فوري.</i>"
        )
        return await self.send_message(msg)

    # -------------------------------------------------------------------------
    # Statistical Report Formatting
    # -------------------------------------------------------------------------

    def format_stats_report(self, stats: dict) -> str:
        """Format server stats into a structured, readable Telegram HTML message."""
        uptime_sec = stats.get("server_uptime_seconds", 0)
        hours, rem = divmod(uptime_sec, 3600)
        minutes, seconds = divmod(rem, 60)
        uptime_str = f"{hours}h {minutes}m {seconds}s" if hours > 0 else f"{minutes}m {seconds}s"

        active_users = stats.get("active_users_count", 0)
        active_streamers = stats.get("active_streamers_count", 0)
        streamers_list = stats.get("active_sessions", [])
        total_connections = stats.get("total_connections", 0)
        search_history = stats.get("search_history", [])

        # Calculate diamonds from history
        total_diamonds = sum(r.get("total_diamonds", 0) for r in search_history)
        est_usd = round(total_diamonds * 0.005, 2)

        streamers_display = ", ".join([f"@{s}" for s in streamers_list]) if streamers_list else "لا توجد جلسات نشطة حالياً"

        # Recent searches preview (last 5)
        history_lines = []
        for r in search_history[:5]:
            uname = html.escape(str(r.get("username", "unknown")))
            status = "🟢 نشط" if r.get("status") == "active" else "⚪ مكتمل"
            dur = r.get("duration_seconds", 0)
            dur_str = f"{dur//60}د {dur%60}ث"
            dm = r.get("total_diamonds", 0)
            history_lines.append(f"• @{uname} ({status}) — ⏱️ {dur_str} | 💎 {dm:,}")

        history_block = "\n".join(history_lines) if history_lines else "• لا يوجد سجل بعد"

        report = (
            "📊 <b>تقرير إحصائيات راصد تيك توك المباشر</b>\n"
            f"📅 <b>التوقيت:</b> {time.strftime('%Y-%m-%d %H:%M:%S')}\n"
            "━━━━━━━━━━━━━━━━━━━━\n"
            f"👥 <b>المستخدمون المتصلون بالموقع الآن:</b> <code>{active_users}</code>\n"
            f"📡 <b>البثوث المتابعة حالياً:</b> <code>{active_streamers}</code>\n"
            f"🎯 <b>قائمة البثوث النشطة:</b> {html.escape(streamers_display)}\n"
            f"🔍 <b>إجمالي عمليات التتبع منذ التشغيل:</b> <code>{total_connections}</code>\n"
            f"⏱️ <b>مدة تشغيل السيرفر المستمرة:</b> <code>{uptime_str}</code>\n"
            "━━━━━━━━━━━━━━━━━━━━\n"
            f"💎 <b>إجمالي ألماسات الجلسات:</b> <code>{total_diamonds:,}</code>\n"
            f"💵 <b>القيمة التقديرية (USD):</b> <code>~${est_usd}</code>\n"
            "━━━━━━━━━━━━━━━━━━━━\n"
            "📜 <b>آخر عمليات التتبع:</b>\n"
            f"{history_block}\n"
            "━━━━━━━━━━━━━━━━━━━━\n"
            "🤖 <i>أرسل /stats في أي وقت لتحديث الإحصائيات فورياً</i>"
        )
        return report

    async def send_stats_report(self) -> tuple[bool, str]:
        """Fetch latest statistics and push report to configured Telegram chat."""
        if not self.enabled:
            return False, "بوت تلغرام معطل في الإعدادات."
        if not self._stats_provider:
            return False, "مزود الإحصائيات غير مرتبط."

        stats = self._stats_provider()
        text = self.format_stats_report(stats)
        return await self.send_message(text)

    # -------------------------------------------------------------------------
    # Event-Driven Real-Time Notifications
    # -------------------------------------------------------------------------

    async def notify_stream_started(self, username: str, viewer_count: int = 1) -> None:
        """Notify Telegram when a user starts tracking a new live stream."""
        if not self.enabled or not self.notify_on_new_stream:
            return

        text = (
            "🟢 <b>بدء تتبع بث مباشر جديد</b>\n"
            f"👤 <b>الحساب:</b> @{html.escape(username)}\n"
            f"👥 <b>المشاهدون المتصلون:</b> {viewer_count}\n"
            f"⏰ <b>الوقت:</b> {time.strftime('%H:%M:%S')}\n"
            f"🔗 <a href='https://www.tiktok.com/@{html.escape(username)}/live'>رابط البث على تيك توك</a>"
        )
        await self.send_message(text)

    async def notify_stream_ended(self, username: str, duration_seconds: int, total_diamonds: int) -> None:
        """Notify Telegram when a tracking session finishes."""
        if not self.enabled or not self.notify_on_stream_end:
            return

        mins = duration_seconds // 60
        secs = duration_seconds % 60
        dur_str = f"{mins} دقيقة و {secs} ثانية" if mins > 0 else f"{secs} ثانية"
        est_usd = round(total_diamonds * 0.005, 2)

        text = (
            "🔴 <b>انتهاء جلسة تتبع</b>\n"
            f"👤 <b>الحساب:</b> @{html.escape(username)}\n"
            f"⏱️ <b>مدة الجلسة:</b> {dur_str}\n"
            f"💎 <b>الألماسات المسجلة:</b> {total_diamonds:,}\n"
            f"💵 <b>القيمة التقديرية:</b> ~${est_usd}\n"
            f"⏰ <b>وقت الانتهاء:</b> {time.strftime('%H:%M:%S')}"
        )
        await self.send_message(text)

    # -------------------------------------------------------------------------
    # Background Tasks: Long-Polling Commands & Periodic Reports
    # -------------------------------------------------------------------------

    async def start(self) -> None:
        """Start Telegram background tasks (long polling & periodic scheduler)."""
        if self._running:
            return
        self._running = True

        if self.enabled and self.bot_token:
            self._polling_task = asyncio.create_task(self._polling_loop(), name="telegram-poll")
            if self.periodic_report_hours > 0:
                self._periodic_task = asyncio.create_task(self._periodic_loop(), name="telegram-periodic")
            logger.info("Telegram Bot service started.")

    async def stop(self) -> None:
        """Stop all Telegram background tasks."""
        self._running = False
        if self._polling_task and not self._polling_task.done():
            self._polling_task.cancel()
            try:
                await self._polling_task
            except asyncio.CancelledError:
                pass

        if self._periodic_task and not self._periodic_task.done():
            self._periodic_task.cancel()
            try:
                await self._periodic_task
            except asyncio.CancelledError:
                pass
        logger.info("Telegram Bot service stopped.")

    async def restart(self) -> None:
        """Restart background tasks (called after settings update)."""
        await self.stop()
        await self.start()

    async def _polling_loop(self) -> None:
        """Long-poll Telegram for incoming user commands."""
        logger.info("Telegram command polling started.")
        while self._running and self.enabled and self.bot_token:
            try:
                url = f"https://api.telegram.org/bot{self.bot_token}/getUpdates"
                params = {"offset": self._last_update_id + 1, "timeout": 20}

                async with httpx.AsyncClient(timeout=25.0) as client:
                    res = await client.get(url, params=params)
                    if res.status_code == 200:
                        data = res.json()
                        updates = data.get("result", [])
                        for update in updates:
                            self._last_update_id = update.get("update_id", self._last_update_id)
                            msg = update.get("message", {})
                            await self._handle_telegram_message(msg)
                    elif res.status_code == 409:
                        # Another instance polling or webhook active
                        await asyncio.sleep(5)
                    else:
                        await asyncio.sleep(3)

            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.debug("Telegram polling transient error: %s", exc)
                await asyncio.sleep(5)

    async def _handle_telegram_message(self, msg: dict) -> None:
        """Process incoming command messages."""
        if not msg:
            return

        chat = msg.get("chat", {})
        sender_chat_id = str(chat.get("id", ""))
        text = str(msg.get("text", "")).strip()

        if not text:
            return

        # Security check: if chat_id is set, only respond to authorized chat
        if self.chat_id and sender_chat_id != self.chat_id:
            logger.warning("Ignored Telegram message from unauthorized chat_id: %s", sender_chat_id)
            return

        # If chat_id was not set, allow pairing via /start
        if not self.chat_id and text.startswith("/start"):
            self.chat_id = sender_chat_id
            self.save_config({"chat_id": sender_chat_id, "enabled": True})
            welcome = (
                f"🎉 <b>تم ربط محادثتك بنجاح!</b>\n"
                f"معرف المحادثة المسجل: <code>{sender_chat_id}</code>\n\n"
                "الأوامر المتاحة:\n"
                "/stats — عرض الإحصائيات الفورية الشاملة\n"
                "/users — قائمة المشاهدين والبثوث النشطة\n"
                "/history — آخر 10 عمليات تتبع\n"
                "/help — المساعدة وطريقة الاستخدام"
            )
            await self.send_message(welcome, chat_id=sender_chat_id)
            return

        cmd = text.split()[0].lower()

        if cmd in ("/start", "/help"):
            help_text = (
                "🤖 <b>بوت راصد تيك توك — TikTok Live Analytics</b>\n"
                "━━━━━━━━━━━━━━━━━━━━\n"
                "الأوامر المتاحة للتحكم والمتابعة:\n"
                "📊 <b>/stats</b> أو <b>/report</b> — تقرير إحصائي مباشر ولحظي\n"
                "👥 <b>/users</b> — المتصلون حالياً والبثوث المتابعة\n"
                "📜 <b>/history</b> — آخر 10 عمليات بحث مكتملة ونشطة\n"
                "ℹ️ <b>/help</b> — عرض هذه الرسالة\n\n"
                "💡 <i>يتم إرسال تنبيهات تلقائية عند بدء تتبع أي بث جديد أو انتهائه.</i>"
            )
            await self.send_message(help_text, chat_id=sender_chat_id)

        elif cmd in ("/stats", "/report"):
            if self._stats_provider:
                stats = self._stats_provider()
                report = self.format_stats_report(stats)
                await self.send_message(report, chat_id=sender_chat_id)
            else:
                await self.send_message("⚠️ لم يتم ربط مزود الإحصائيات بالسيرفر بعد.", chat_id=sender_chat_id)

        elif cmd == "/users":
            if self._stats_provider:
                stats = self._stats_provider()
                active_users = stats.get("active_users_count", 0)
                active_sessions = stats.get("active_sessions", [])
                lines = [
                    f"👥 <b>المستخدمون المتصلون:</b> <code>{active_users}</code>",
                    f"📡 <b>عدد البثوث النشطة:</b> <code>{len(active_sessions)}</code>",
                    "━━━━━━━━━━━━━━━━━━━━",
                ]
                if active_sessions:
                    for s in active_sessions:
                        lines.append(f"• @{html.escape(s)}")
                else:
                    lines.append("<i>لا توجد جلسات تتبع نشطة حالياً.</i>")
                await self.send_message("\n".join(lines), chat_id=sender_chat_id)

        elif cmd == "/history":
            if self._stats_provider:
                stats = self._stats_provider()
                history = stats.get("search_history", [])[:10]
                lines = ["📜 <b>آخر 10 عمليات تتبع:</b>", "━━━━━━━━━━━━━━━━━━━━"]
                if history:
                    for r in history:
                        uname = html.escape(str(r.get("username", "unknown")))
                        st = "🟢 نشط" if r.get("status") == "active" else "⚪ منتهي"
                        dur = r.get("duration_seconds", 0)
                        lines.append(f"• @{uname} ({st}) — ⏱️ {dur//60}د {dur%60}ث | 💎 {r.get('total_diamonds', 0):,}")
                else:
                    lines.append("<i>لا يوجد سجل تتبع مسجل.</i>")
                await self.send_message("\n".join(lines), chat_id=sender_chat_id)

    async def _periodic_loop(self) -> None:
        """Periodic automated report generator."""
        while self._running and self.enabled and self.periodic_report_hours > 0:
            try:
                await asyncio.sleep(self.periodic_report_hours * 3600)
                if self._running and self.enabled:
                    logger.info("Sending periodic Telegram stats report...")
                    await self.send_stats_report()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("Periodic report error: %s", exc)
                await asyncio.sleep(60)
