# =============================================================================
#  control.py — One-Stop Management CLI for TikTok Tracker Background Service
# =============================================================================
"""
CLI Controller to manage background operations:
  python control.py start             -> Start background supervisor & services
  python control.py stop              -> Stop all background services
  python control.py restart           -> Restart background services
  python control.py status            -> Check status & show live public URL
  python control.py install-startup   -> Run automatically on Windows boot
  python control.py uninstall-startup -> Disable auto-run on Windows boot
"""

import os
import sys
import time
import socket
import subprocess
from pathlib import Path
import urllib.request

# Ensure UTF-8 output on Windows console
if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr and hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BASE_DIR = Path(__file__).parent.resolve()
LOGS_DIR = BASE_DIR / "logs"
LOGS_DIR.mkdir(exist_ok=True)

PID_FILE = LOGS_DIR / "supervisor.pid"
SUPERVISOR_LOG = LOGS_DIR / "supervisor.log"
TUNNEL_FILE = BASE_DIR / "tunnel.txt"

# Windows flags to start detached background process without opening a console window
CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008


import ctypes


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


def is_pid_running(pid: int) -> bool:
    """Check if process PID is running using kernel32 (instantaneous)."""
    if pid <= 0:
        return False
    try:
        # 0x1000 = PROCESS_QUERY_LIMITED_INFORMATION
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if handle:
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
    except Exception:
        pass
    return False


def get_supervisor_pid() -> int | None:
    """Return supervisor PID if running."""
    if not PID_FILE.exists():
        return None
    try:
        pid = int(PID_FILE.read_text(encoding="utf-8").strip())
        if is_pid_running(pid):
            return pid
    except Exception:
        pass
    return None


def is_port_open(port: int = 8000) -> bool:
    """Check if port is open and accepting TCP connections."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except Exception:
        return False


def free_port(port: int = 8000) -> None:
    """Free port if currently occupied."""
    if not is_port_open(port):
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
                    time.sleep(0.5)
    except Exception:
        pass


# -----------------------------------------------------------------------------
# Actions
# -----------------------------------------------------------------------------


def cmd_start() -> None:
    print("=" * 65)
    print("      🚀 جاري تشغيل راصد تيك توك في الخلفية 24/7...")
    print("=" * 65)

    existing_pid = get_supervisor_pid()
    if existing_pid:
        print(f"\n[!] السيرفر يعمل بالفعل في الخلفية بالمعرف (PID: {existing_pid})")
        cmd_status()
        return

    # Free port 8000 before launching
    free_port(8000)

    # Launch supervisor completely detached with hidden window
    supervisor_script = BASE_DIR / "supervisor.py"
    subprocess.Popen(
        [sys.executable, str(supervisor_script)],
        cwd=str(BASE_DIR),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=CREATE_NO_WINDOW | DETACHED_PROCESS,
        close_fds=True,
    )

    print("\n[✓] تم إطلاق مراقب المنصة في الخلفية بنجاح!")
    print("[i] جاري الاتصال وتوليد الرابط العام (انتظر ثوانٍ)...")

    # Wait up to 10 seconds for tunnel.txt to update
    for _ in range(10):
        time.sleep(1)
        if TUNNEL_FILE.exists():
            content = TUNNEL_FILE.read_text(encoding="utf-8").strip()
            if "your url is:" in content:
                break

    print("\n" + "=" * 65)
    if TUNNEL_FILE.exists():
        print(TUNNEL_FILE.read_text(encoding="utf-8").strip())
    else:
        print("جاري إنشاء الرابط، وسيصلك إشعار فوري عبر بوت التلغرام الخاص بك!")
    print("=" * 65)
    print("\n💡 السيرفر يعمل الآن في الخلفية دون أي نوافذ مفتوحة.")
    print("💡 في حال حدوث أي انقطاع، سيقوم المراقب بإعادة التشغيل تلقائياً.")
    print("💡 لإيقاف السيرفر: python control.py stop  (أو stop_tracker.bat)")
    print("💡 لمشاهدة الحالة: python control.py status (أو status_tracker.bat)")


def cmd_stop() -> None:
    print("=" * 65)
    print("      🛑 جاري إيقاف راصد تيك توك وجميع العمليات في الخلفية...")
    print("=" * 65)

    pid = get_supervisor_pid()
    if pid:
        print(f"[i] إنهاء عملية المراقب (PID: {pid})...")
        kill_proc_tree(pid)
    else:
        print("[i] لم يتم العثور على مراقب نشط.")

    if PID_FILE.exists():
        PID_FILE.unlink(missing_ok=True)

    print("[i] إيقاف خادم Uvicorn على المنفذ 8000...")
    free_port(8000)

    print("[i] إيقاف نفق الاتصال Localtunnel...")
    try:
        subprocess.call("taskkill /F /IM node.exe", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass

    print("\n" + "=" * 65)
    print("   ✅ تم إيقاف جميع العمليات وخدمات المنصة بنجاح!")
    print("=" * 65)


def cmd_status() -> None:
    print("=" * 65)
    print("           📊 حالة منصة راصد تيك توك في الخلفية")
    print("=" * 65)

    pid = get_supervisor_pid()
    if pid:
        print(f"[✓] المراقب الذاتي: نشط ويعمل بالمعرف (PID: {pid})")
    else:
        print("[✗] المراقب الذاتي: غير نشط حالياً.")

    port_open = is_port_open(8000)
    if port_open:
        print("[✓] خادم المنصة (Port 8000): نشط ويستقبل الاتصالات.")
    else:
        print("[✗] خادم المنصة (Port 8000): غير متصل.")

    # HTTP Health
    try:
        req = urllib.request.Request("http://127.0.0.1:8000/health")
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            if resp.status == 200:
                print("[✓] فحص الصحة البرمجية (HTTP Health): ممتاز (200 OK)")
    except Exception:
        print("[!] فحص الصحة البرمجية (HTTP Health): لم يستجب.")

    print("\n" + "-" * 65)
    print("🌐 تفاصيل الرابط العام:")
    print("-" * 65)
    if TUNNEL_FILE.exists():
        print(TUNNEL_FILE.read_text(encoding="utf-8").strip())
    else:
        print("لم يتم العثور على ملف الرابط tunnel.txt.")

    print("\n" + "-" * 65)
    print("📝 آخر 8 أسطر من سجل المراقب (supervisor.log):")
    print("-" * 65)
    if SUPERVISOR_LOG.exists():
        lines = SUPERVISOR_LOG.read_text(encoding="utf-8", errors="ignore").splitlines()
        for line in lines[-8:]:
            print(line)
    else:
        print("لا توجد سجلات بعد.")
    print("=" * 65)


def cmd_install_startup() -> None:
    print("=" * 65)
    print("   ⚙️ تثبيت التشغيل التلقائي مع بدء تشغيل ويندوز (Windows Startup)")
    print("=" * 65)

    startup_dir = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    if not startup_dir.exists():
        print(f"[✗] تعذر العثور على مجلد بدء التشغيل: {startup_dir}")
        return

    shortcut_path = startup_dir / "TikTokLiveTracker.lnk"
    vbs_path = BASE_DIR / "start_hidden.vbs"

    ps_script = (
        f"$ws = New-Object -ComObject WScript.Shell; "
        f"$s = $ws.CreateShortcut('{str(shortcut_path)}'); "
        f"$s.TargetPath = 'wscript.exe'; "
        f"$s.Arguments = '\"{str(vbs_path)}\"'; "
        f"$s.WorkingDirectory = '{str(BASE_DIR)}'; "
        f"$s.Save()"
    )
    subprocess.call(["powershell", "-NoProfile", "-Command", ps_script])

    if shortcut_path.exists():
        print("\n✅ تم تثبيت التشغيل التلقائي بنجاح!")
        print("💡 عند تشغيل جهاز الكمبيوتر أو إعادة تشغيله:")
        print("   - سيبدأ راصد تيك توك في الخلفية تلقائياً وبشكل صامت تماماً.")
        print("   - سيصلك إشعار فوري على بوت التلغرام برابط الموقع المباشر وكلمة السر.")
    else:
        print("[✗] حدث خطأ أثناء إنشاء الاختصار في مجلد بدء التشغيل.")
    print("=" * 65)


def cmd_uninstall_startup() -> None:
    print("=" * 65)
    print("   🛑 إلغاء التشغيل التلقائي مع بدء تشغيل ويندوز")
    print("=" * 65)

    startup_dir = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    shortcut_path = startup_dir / "TikTokLiveTracker.lnk"

    if shortcut_path.exists():
        shortcut_path.unlink()
        print("\n✅ تم حذف الاختصار من مجلد بدء التشغيل بنجاح.")
        print("💡 لن يتم تشغيل السيرفر تلقائياً عند إقلاع ويندوز.")
    else:
        print("\n[i] التشغيل التلقائي غير مفعل بالفعل.")
    print("=" * 65)


# -----------------------------------------------------------------------------
# Main Entry Point
# -----------------------------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) < 2:
        cmd_status()
        sys.exit(0)

    action = sys.argv[1].lower().strip("-")
    if action == "start":
        cmd_start()
    elif action == "stop":
        cmd_stop()
    elif action == "restart":
        cmd_stop()
        time.sleep(2)
        cmd_start()
    elif action in ("status", "info"):
        cmd_status()
    elif action in ("install", "install-startup", "startup"):
        cmd_install_startup()
    elif action in ("uninstall", "uninstall-startup", "remove-startup"):
        cmd_uninstall_startup()
    else:
        print(f"Unknown command: {action}")
        print("Usage: python control.py [start|stop|restart|status|install-startup|uninstall-startup]")
