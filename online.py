"""Puts the drawing server on the internet for the Vercel page.

Starts the server (when it is not running) and a free Cloudflare tunnel to it, then shows the link to open:
    https://loopdrawing.vercel.app/?server=https://<random>.trycloudflare.com
The page keeps the tunnel address in the browser, so a device that opened the link once can just use the Vercel address again
until the tunnel address changes (every time this program is started). Needs cloudflared:  winget install Cloudflare.cloudflared
Close the window (or Ctrl+C) to stop the tunnel. Anyone who has the link can use the server: share it only with your team.
"""
import os
import re
import shutil
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
SITE = os.environ.get("LOOP_SITE", "https://loopdrawing.vercel.app").rstrip("/")
PORT = int(os.environ.get("LOOP_SERVER_PORT", 8765))
TUNNEL_URL = re.compile(r"https://[a-z0-9-]+(?:\.[a-z0-9-]+)*\.trycloudflare\.com")


def find_cloudflared():
    found = os.environ.get("LOOP_CLOUDFLARED") or shutil.which("cloudflared")
    if found:
        return found
    for base in (os.environ.get("LOCALAPPDATA", ""), os.environ.get("ProgramFiles", ""), os.environ.get("ProgramFiles(x86)", "")):
        for rel in ("Microsoft/WinGet/Links/cloudflared.exe", "cloudflared/cloudflared.exe"):
            p = Path(base) / rel
            if base and p.exists():
                return str(p)
    return None


def healthy():
    try:
        with urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1.5) as r:
            return r.status == 200
    except OSError:
        return False


def main():
    cloudflared = find_cloudflared()
    if not cloudflared:
        print("cloudflared is not installed. Install it once (in a normal command window), then run this again:\n"
              "    winget install --id Cloudflare.cloudflared")
        return 1

    server = None
    if not healthy():
        log = open(ROOT / "data" / "server.log", "ab") if (ROOT / "data").exists() else subprocess.DEVNULL
        server = subprocess.Popen([sys.executable, "server.py", "--no-browser", "--port", str(PORT)], cwd=ROOT,
                                  stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                  creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        for _ in range(120):
            if healthy():
                break
            time.sleep(0.5)
        else:
            print("The server did not start (see data/server.log).")
            server.terminate()
            return 1
    print(f"Server is running on this PC (port {PORT}). Opening the tunnel ...")

    tunnel = subprocess.Popen([cloudflared, "tunnel", "--url", f"http://127.0.0.1:{PORT}", "--no-autoupdate"],
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
    try:
        link = None
        for line in tunnel.stdout:
            m = TUNNEL_URL.search(line)
            if m and not link:
                link = f"{SITE}/?server={m.group()}"
                print("\n" + "=" * 70 + f"\n  Open this link (on any device with internet):\n\n  {link}\n" + "=" * 70)
                print("\n  It is copied to the clipboard. Keep this window open - closing it stops the tunnel.")
                subprocess.run("clip", input=link, text=True, shell=True)
                webbrowser.open(link)
        print("The tunnel stopped.")
    except KeyboardInterrupt:
        pass
    finally:
        tunnel.terminate()
        if server:
            server.terminate()
    return 0


if __name__ == "__main__":
    sys.exit(main())
