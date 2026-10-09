"""Private, bounded Hermes web worker. Every request gets a disposable profile."""
import hmac
import json
import os
import signal
import socket
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cache import Coordinator, PREFIX

slots = threading.BoundedSemaphore(2)
coordinator = Coordinator.configured()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log prompts, source content, or credentials.

    def send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/cache/status":
            token = os.environ.get("WEB_RESEARCH_TOKEN", "")
            if not token or not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                return self.send(401, {"error": "unauthorized"})
            try:
                client = coordinator.client
                connected = bool(client and client.ping())
                persistence = client.config_get("save", "appendonly") if connected else {}
                return self.send(200, {"redis": connected, "persistence": persistence,
                    "semantic_ready": bool(getattr(getattr(coordinator.embed, "__self__", None), "model", None)),
                    "active": client.zcard(PREFIX + "active") if connected else 0})
            except Exception:
                return self.send(200, {"redis": False})
        ready = all(os.environ.get(key) for key in ("WEB_RESEARCH_TOKEN", "RESEARCH_MODEL_URL", "RESEARCH_MODEL_TOKEN"))
        self.send((200 if ready else 503) if self.path == "/health" else 404,
                  {"status": ("ok" if ready else "not_configured") if self.path == "/health" else "not_found"})

    def do_POST(self):
        token = os.environ.get("WEB_RESEARCH_TOKEN", "")
        if not token or not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
            return self.send(401, {"error": "unauthorized"})
        if self.path != "/research":
            return self.send(404, {"error": "not_found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 24000:
                return self.send(413, {"error": "request_too_large"})
            data = json.loads(self.rfile.read(length))
            if not isinstance(data.get("message"), str) or not data["message"].strip():
                return self.send(400, {"error": "message_required"})
            if (not isinstance(data.get("urls", []), list) or len(data.get("urls", [])) > 4
                    or any(not isinstance(url, str) or not url.startswith(("https://", "http://")) for url in data.get("urls", []))):
                return self.send(400, {"error": "invalid_urls"})
        except (ValueError, AttributeError):
            return self.send(400, {"error": "invalid_request"})
        self.send(*coordinator.run(data, crawl))


def crawl(data, timeout=180):
    if not slots.acquire(blocking=False):
        return 429, {"error": "busy"}
    try:
        with tempfile.TemporaryDirectory(prefix="research-") as profile:
            Path(profile, "config.yaml").write_text("web:\n  backend: firecrawl\n  search_backend: ddgs\n  extract_char_limit: 10000\n", encoding="utf-8")
            env = {**os.environ, "HERMES_HOME": profile}
            process = subprocess.Popen([sys.executable, "/app/research.py"], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env, start_new_session=True)
            try:
                output, _ = process.communicate(json.dumps(data), timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                output, _ = process.communicate()
            events = []
            for line in output.splitlines():
                try:
                    event = json.loads(line)
                    if isinstance(event, dict) and event.get("event") in ("result", "retrieved"):
                        events.append(event)
                except ValueError:
                    pass
            final = next((event for event in reversed(events) if event["event"] == "result"), None)
            if final and not final.get("error"):
                return 200, final
            partial = next((event for event in reversed(events) if event["event"] == "retrieved"), {})
            if final and not partial:
                return 200, final
            text = "Web research could not finish the analysis. Please retry."
            return 200, {"content": text, "sources": [], "error": "incomplete"}
    except (OSError, ValueError):
        return 503, {"error": "worker_unavailable"}
    finally:
        slots.release()

if __name__ == "__main__":
    class DualStackServer(ThreadingHTTPServer):
        address_family = socket.AF_INET6

        def server_bind(self):
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            super().server_bind()

    DualStackServer(("::", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
