# =============================================================================
#  supervisor.py — 24/7 Self-Healing Background Watchdog for TikTok Tracker
# =============================================================================
"""
Supervises Uvicorn server and Cloudflare / Localtunnel:
- Ensures single instance via PID file.
- Starts processes silently in the background.
- Captures logs into logs/ directory (uvicorn.log, tunnel.log, supervisor.log).
- Detects crashes or disconnects and automatically restarts them.
- Updates tunnel.txt with the active public URL.
- Sends instant Telegram alert with live URL and credentials.
- Gracefully shuts down child processes on exit.
"""

import os
import re
import sys
import time
import json
import socket
import signal
import logging
import subprocess
import threading
from pathlib import Path
import urllib.request
import urllib.error

# Ensure UTF-8 output on Windows console
if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr and hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BASE_DIR = Path(__file__).parent.resolve()
LOGS_DIR = BASE_DIR / "logs"
LOGS_DIR.mkdir(exist_ok=True)

SUPERVISOR_LOG = LOGS_DIR / "supervisor.log"
UVICORN_LOG = LOGS_DIR / "uvicorn.log"
TUNNEL_LOG = LOGS_DIR / "tunnel.log"
PID_FILE = LOGS_DIR / "supervisor.pid"
TUNNEL_FILE = BASE_DIR / "tunnel.txt"
CONFIG_FILE = BASE_DIR / "backend" / "telegram_config.json"
CLOUDFLARED_BIN = BASE_DIR / "cloudflared.exe"

log_handlers: list[logging.Handler] = [logging.FileHandler(SUPERVISOR_LOG, encoding="utf-8")]
if sys.stdout is not None:
    log_handlers.append(logging.StreamHandler(sys.stdout))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [SUPERVISOR] %(message)s",
    handlers=log_handlers,
)
logger = logging.getLogger("supervisor")


def kill_proc_tree(pid: int) -> None:
    """Force kill a process and all its children on Windows."""
    try:
        subprocess.call(
            f"taskkill /F /T /PID {pid}",
            shell=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass


import ctypes


def is_pid_alive(pid: int) -> bool:
    """Check if process PID is running via kernel32."""
    if pid <= 0:
        return False
    try:
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if handle:
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
    except Exception:
        pass
    return False


def check_single_instance() -> None:
    """Ensure only one supervisor is running at any time."""
    if PID_FILE.exists():
        try:
            old_pid = int(PID_FILE.read_text(encoding="utf-8").strip())
            if old_pid != os.getpid() and is_pid_alive(old_pid):
                logger.warning("Another supervisor instance (PID %d) is running. Stopping it...", old_pid)
                kill_proc_tree(old_pid)
                time.sleep(0.5)
        except Exception:
            pass

    PID_FILE.write_text(str(os.getpid()), encoding="utf-8")


def remove_pid_file() -> None:
    """Remove PID file on clean exit."""
    try:
        if PID_FILE.exists():
            PID_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def get_public_ip() -> str:
    """Fetch current public IP for localtunnel password."""
    for url in ("https://loca.lt/mytunnelpassword", "https://api.ipify.org", "https://icanhazip.com"):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "curl/7.68.0"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                ip = resp.read().decode("utf-8").strip()
                if ip and "." in ip:
                    return ip
        except Exception:
            continue
    return "41.102.12.61"


def send_telegram_alert(message: str) -> None:
    """Send formatted Telegram notification to owner."""
    try:
        if not CONFIG_FILE.exists():
            return
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        bot_token = data.get("bot_token", "").strip()
        chat_id = str(data.get("chat_id", "")).strip()
        if not bot_token or not chat_id:
            return

        api_url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        payload = json.dumps({
            "chat_id": chat_id,
            "text": message,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }).encode("utf-8")

        req = urllib.request.Request(
            api_url,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            pass
        logger.info("Telegram notification sent successfully.")
    except Exception as exc:
        logger.warning("Could not send Telegram alert: %s", exc)


def is_port_in_use(port: int = 8000) -> bool:
    """Quick socket check to see if port is open."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except Exception:
        return False


def free_port(port: int = 8000) -> None:
    """Terminate any process holding the specified port if active."""
    if not is_port_in_use(port):
        return
    try:
        out = subprocess.check_output(
            f"netstat -aon | findstr :{port}",
            shell=True,
            text=True,
            stderr=subprocess.DEVNULL,
        )
        for line in out.strip().splitlines():
            if "LISTENING" in line:
                pid = line.strip().split()[-1]
                if pid and pid.isdigit() and int(pid) != os.getpid():
                    kill_proc_tree(int(pid))
                    logger.info("Freed port %d by killing PID %s", port, pid)
                    time.sleep(0.5)
    except Exception:
        pass


def check_health(port: int = 8000) -> bool:
    """Robust health check: verifies socket port and HTTP endpoint."""
    if not is_port_in_use(port):
        return False
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/health")
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            return resp.status == 200
    except Exception:
        # If the port is open and accepting TCP connections, the process is alive (possibly busy)
        return is_port_in_use(port)


def find_localtunnel_cmd() -> str:
    """Locate lt or lt.cmd executable on Windows."""
    npm_path = Path(os.environ.get("APPDATA", "")) / "npm" / "lt.cmd"
    if npm_path.exists():
        return str(npm_path)
    return "lt"


class BackgroundSupervisor:
    def __init__(self) -> None:
        self.uvicorn_proc: subprocess.Popen | None = None
        self.tunnel_proc: subprocess.Popen | None = None
        self.current_url: str = ""
        self.tunnel_type: str = "cloudflare" if CLOUDFLARED_BIN.exists() else "localtunnel"
        self._cf_fail_count: int = 0
        self.running: bool = True
        self.uvicorn_log_file = None
        self.tunnel_log_file = None

    def start_uvicorn(self) -> None:
        """Start or restart the uvicorn web server."""
        if self.uvicorn_proc and self.uvicorn_proc.poll() is None:
            return

        logger.info("Starting Uvicorn server on port 8000...")
        free_port(8000)

        if self.uvicorn_log_file and not self.uvicorn_log_file.closed:
            try:
                self.uvicorn_log_file.close()
            except Exception:
                pass

        self.uvicorn_log_file = open(UVICORN_LOG, "a", encoding="utf-8")
        cmd = [
            sys.executable,
            "-m",
            "uvicorn",
            "backend.main:app",
            "--host",
            "0.0.0.0",
            "--port",
            "8000",
        ]
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        self.uvicorn_proc = subprocess.Popen(
            cmd,
            cwd=str(BASE_DIR),
            stdin=subprocess.DEVNULL,
            stdout=self.uvicorn_log_file,
            stderr=subprocess.STDOUT,
            env=env,
        )

        # Wait up to 60 seconds for server to become responsive
        for _ in range(60):
            time.sleep(1)
            if check_health(8000):
                logger.info("Uvicorn is healthy and accepting connections.")
                return
        logger.warning("Uvicorn startup verification completed.")

    def start_tunnel(self) -> None:
        """Start or restart public tunnel (Cloudflare prioritized, Localtunnel fallback)."""
        if self.tunnel_proc and self.tunnel_proc.poll() is None:
            return

        if CLOUDFLARED_BIN.exists() and self._cf_fail_count < 2:
            self._start_cloudflare_tunnel()
        else:
            self._start_localtunnel()

    def _start_cloudflare_tunnel(self) -> None:
        """Start Cloudflare Tunnel via cloudflared.exe (Zero Password, Direct Access)."""
        logger.info("Starting Cloudflare Tunnel via %s (attempt %d/2)...", CLOUDFLARED_BIN, self._cf_fail_count + 1)
        self.tunnel_type = "cloudflare"
        cmd = [str(CLOUDFLARED_BIN), "tunnel", "--protocol", "http2", "--url", "http://127.0.0.1:8000"]

        self.tunnel_proc = subprocess.Popen(
            cmd,
            cwd=str(BASE_DIR),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        t = threading.Thread(target=self._monitor_cloudflare_output, daemon=True)
        t.start()

    def _monitor_cloudflare_output(self) -> None:
        """Read and parse cloudflared output for trycloudflare URL."""
        if not self.tunnel_proc or not self.tunnel_proc.stdout:
            return

        url_pattern = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")
        captured = False
        try:
            with open(TUNNEL_LOG, "a", encoding="utf-8") as tf:
                for line in iter(self.tunnel_proc.stdout.readline, ""):
                    if not line:
                        break
                    clean_line = line.strip()
                    tf.write(line)
                    if "unauthorized: tunnel not found" in clean_line.lower():
                        logger.warning("Cloudflare reported tunnel expired/not found! Killing dead tunnel process...")
                        if self.tunnel_proc and self.tunnel_proc.pid:
                            kill_proc_tree(self.tunnel_proc.pid)
                        break

                    match = url_pattern.search(clean_line)
                    if match:
                        url = match.group(0).strip()
                        captured = True
                        self._cf_fail_count = 0
                        if url != self.current_url:
                            self.current_url = url
                            logger.info("Cloudflare Tunnel URL captured: %s", self.current_url)

                            # Update tunnel.txt
                            content = (
                                f"your url is: {self.current_url}\n"
                                f"admin url is: {self.current_url}/admin\n"
                                f"tunnel provider: Cloudflare Tunnel (سريع، مباشر، وبدون أي كلمة سر)\n"
                            )
                            TUNNEL_FILE.write_text(content, encoding="utf-8")

                            # Send Telegram alert
                            tg_msg = (
                                "🚀 <b>تم تشغيل راصد تيك توك بنجاح!</b>\n"
                                "━━━━━━━━━━━━━━━━━━━━\n"
                                f"🌐 <b>رابط الموقع المباشر (دخول فوري بدون كلمة سر):</b>\n"
                                f"<a href='{self.current_url}'>{self.current_url}</a>\n\n"
                                f"⚙️ <b>لوحة تحكم الأدمن:</b>\n"
                                f"<a href='{self.current_url}/admin'>{self.current_url}/admin</a>\n\n"
                                f"🔐 <b>كلمة سر الأدمن:</b> <code>admin123</code>\n"
                                "━━━━━━━━━━━━━━━━━━━━\n"
                                "⚡ <i>يعمل مباشرة عبر شبكة Cloudflare فائقة السرعة مع المزامنة اللحظية للهدايا والجولات.</i>"
                            )
                            send_telegram_alert(tg_msg)

        except Exception as exc:
            logger.debug("Cloudflare output reader exited: %s", exc)
        finally:
            if not captured and self.running:
                self._cf_fail_count += 1
                logger.warning("Cloudflare tunnel failed to obtain public URL (failures: %d/2).", self._cf_fail_count)
                if self._cf_fail_count >= 2:
                    logger.warning("Falling back to Localtunnel immediately...")
                    self._start_localtunnel()

    def _start_localtunnel(self) -> None:
        """Fallback to localtunnel if cloudflared is unavailable."""
        lt_cmd = find_localtunnel_cmd()
        self.tunnel_type = "localtunnel"
        logger.info("Starting localtunnel fallback via %s on port 8000...", lt_cmd)
        cmd = f'cmd /c "{lt_cmd} --port 8000"'

        self.tunnel_proc = subprocess.Popen(
            cmd,
            cwd=str(BASE_DIR),
            shell=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        t = threading.Thread(target=self._monitor_lt_output, daemon=True)
        t.start()

    def _monitor_lt_output(self) -> None:
        """Read lines from localtunnel stdout."""
        if not self.tunnel_proc or not self.tunnel_proc.stdout:
            return

        try:
            with open(TUNNEL_LOG, "a", encoding="utf-8") as lt_f:
                for line in iter(self.tunnel_proc.stdout.readline, ""):
                    if not line:
                        break
                    clean_line = line.strip()
                    lt_f.write(line)
                    lt_f.flush()
                    logger.info("[Localtunnel] %s", clean_line)

                    if "your url is:" in clean_line.lower():
                        url = clean_line.split(":")[-2].strip() + ":" + clean_line.split(":")[-1].strip()
                        url = url.replace("your url is", "").replace("Your url is", "").strip()
                        if not url.startswith("http"):
                            url = "https://" + url.lstrip("/:")

                        self.current_url = url
                        pub_ip = get_public_ip()
                        logger.info("Public URL captured: %s (Password/IP: %s)", self.current_url, pub_ip)

                        content = (
                            f"your url is: {self.current_url}\n"
                            f"tunnel password / ip: {pub_ip}\n"
                            f"admin url is: {self.current_url}/admin\n"
                            f"tunnel provider: Localtunnel\n"
                        )
                        TUNNEL_FILE.write_text(content, encoding="utf-8")

                        tg_msg = (
                            "🚀 <b>تم تشغيل راصد تيك توك في الخلفية 24/7 بنجاح!</b>\n"
                            "━━━━━━━━━━━━━━━━━━━━\n"
                            f"🌐 <b>رابط الموقع المباشر:</b>\n"
                            f"<a href='{self.current_url}'>{self.current_url}</a>\n\n"
                            f"⚙️ <b>لوحة تحكم الأدمن:</b>\n"
                            f"<a href='{self.current_url}/admin'>{self.current_url}/admin</a>\n\n"
                            f"🔑 <b>كلمة مرور فتح الرابط (IP):</b> <code>{pub_ip}</code>\n"
                            f"🔐 <b>كلمة سر الأدمن:</b> <code>admin123</code>\n"
                            "━━━━━━━━━━━━━━━━━━━━\n"
                        )
                        send_telegram_alert(tg_msg)

        except Exception as exc:
            logger.debug("LT output reader exited: %s", exc)

    def stop(self) -> None:
        """Stop all processes and cleanup."""
        self.running = False
        logger.info("Stopping TikTok Live Tracker Supervisor...")

        if self.tunnel_proc and self.tunnel_proc.pid:
            kill_proc_tree(self.tunnel_proc.pid)
            self.tunnel_proc = None

        if self.uvicorn_proc and self.uvicorn_proc.pid:
            kill_proc_tree(self.uvicorn_proc.pid)
            self.uvicorn_proc = None

        try:
            subprocess.call("taskkill /F /IM cloudflared.exe", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass

        free_port(8000)
        remove_pid_file()
        logger.info("Supervisor and all services stopped successfully.")

    def run(self) -> None:
        """Main self-healing watchdog loop."""
        check_single_instance()
        logger.info("=== TikTok Live Tracker Background Supervisor Started (PID: %d) ===", os.getpid())

        self.start_uvicorn()
        time.sleep(2)
        self.start_tunnel()

        health_failures = 0
        tunnel_failures = 0
        tunnel_probe_counter = 0

        while self.running:
            time.sleep(5)

            # 1. Check Uvicorn process
            if (self.uvicorn_proc is None or self.uvicorn_proc.poll() is not None) and not is_port_in_use(8000):
                logger.warning("Uvicorn process died! Restarting...")
                self.start_uvicorn()

            # 2. Check health - only restart if port is down and health failed 6 consecutive times (30s)
            if not check_health(8000):
                health_failures += 1
                if health_failures >= 6:
                    if not is_port_in_use(8000):
                        logger.warning("Port 8000 is closed and health failed. Restarting Uvicorn...")
                        if self.uvicorn_proc and self.uvicorn_proc.pid:
                            kill_proc_tree(self.uvicorn_proc.pid)
                        self.start_uvicorn()
                    health_failures = 0
            else:
                health_failures = 0

            # 3. Check Tunnel process
            if self.tunnel_proc is None or self.tunnel_proc.poll() is not None:
                logger.warning("Tunnel process died! Restarting...")
                self.start_tunnel()

            # 4. Check Public Tunnel URL validity (Self-Healing Watchdog)
            if self.current_url:
                tunnel_probe_counter += 1
                if tunnel_probe_counter >= 6:  # Probe every 30 seconds
                    tunnel_probe_counter = 0
                    try:
                        req = urllib.request.Request(
                            f"{self.current_url}/health",
                            headers={"User-Agent": "Mozilla/5.0"}
                        )
                        with urllib.request.urlopen(req, timeout=8.0) as resp:
                            if resp.status == 200:
                                tunnel_failures = 0
                            else:
                                tunnel_failures += 1
                    except Exception as probe_err:
                        tunnel_failures += 1
                        logger.warning("Public tunnel health check failed (%d/3): %s", tunnel_failures, probe_err)

                    if tunnel_failures >= 3:
                        logger.warning("Public tunnel is unreachable or expired! Force-restarting tunnel...")
                        tunnel_failures = 0
                        if self.tunnel_proc and self.tunnel_proc.pid:
                            kill_proc_tree(self.tunnel_proc.pid)
                        try:
                            subprocess.call("taskkill /F /IM cloudflared.exe", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        except Exception:
                            pass
                        self.start_tunnel()


if __name__ == "__main__":
    supervisor = BackgroundSupervisor()

    def handle_signal(sig, frame):
        supervisor.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        supervisor.run()
    except KeyboardInterrupt:
        supervisor.stop()
    except Exception as e:
        logger.exception("Supervisor encountered fatal error: %s", e)
        supervisor.stop()
