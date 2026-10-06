#!/usr/bin/env python3
"""Regression test for the Chrome extension: action icon state, popup
session list, and the bridge request path (fetch/snapshot/eval/closeGroup).

Real pi processes share the bridge hub on 127.0.0.1:17890, and a test
extension must never dial it (the hub has a single extension slot), so
this runs inside an isolated network namespace:

  unshare -Urn sh -c 'ip link set lo up; exec /tmp/pi-ext-venv/bin/python scripts/test-extension.py'

Visible demo (a real window on your desktop; pauses so you can click the
toolbar icon yourself while a fake pi session is connected):

  unshare -Urn sh -c 'ip link set lo up; DEMO=60 exec /tmp/pi-ext-venv/bin/python scripts/test-extension.py'

Requires: playwright (+ Chrome), websockets. Google search is exercised
best-effort: the netns has no external route, so search reports WARN.
"""
import json
import os
import queue
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright
from websockets.sync.server import serve  # type: ignore[import-not-found] # venv-only

EXT_DIR = Path(__file__).resolve().parent.parent / "extension"
CID = "test-conv-abc123"
BRIDGE_PORT = 17890

PAGES = {
    "/page1.html": (
        "<html><head><title>Test Page One</title></head><body><article>"
        "<h1>Alpha</h1><p>MARKER_ONE body text</p>"
        '<a href="/page2.html">to page two</a>'
        "</article></body></html>"
    ),
    "/page2.html": (
        "<html><head><title>Test Page Two</title></head><body><article>"
        "<h1>Beta</h1><p>MARKER_TWO body text</p>"
        "</article></body></html>"
    ),
}

results = []


def check(name, cond, detail=""):
    ok = bool(cond)
    results.append((name, ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{detail}]" if detail else ""))


def warn(name, detail=""):
    print(f"WARN  {name}" + (f"  [{detail}]" if detail else ""))


# ---------- test page server ----------


class PageHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = PAGES.get(self.path)
        if body is None:
            self.send_error(404)
            return
        data = body.encode()
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):  # noqa: A002 - base class signature
        pass


# ---------- fake bridge hub ----------


class FakeHub:
    """Plays the bridge hub on 127.0.0.1:17890: one registered pi client
    (cid); requests are originated directly — the extension cannot tell
    hub-originated from routed."""

    NEW_CID = "new-conv-xyz789"

    def __init__(self, cid):
        self.cid = cid
        self.ws = None
        self.renewed = False
        self.next_id = 1
        self.pending = {}
        self.connected = threading.Event()
        self.released = threading.Event()

    def sessions(self):
        if self.released.is_set():
            return []
        if self.renewed:
            # /new: same process, fresh conversationId, new clientId.
            return [{"clientId": 2, "conversationId": self.NEW_CID,
                     "project": "fake-project", "self": False}]
        return [{"clientId": 1, "conversationId": self.cid,
                 "project": "fake-project", "self": False}]

    def push_sessions(self):
        if self.ws:
            self.ws.send(json.dumps({
                "type": "sessions", "sessions": self.sessions(),
            }))

    def _handler(self, ws):
        # The real hub has ONE extension slot: a second extHello is
        # rejected and closed (hub keeps the first connection).
        if self.ws is not None:
            ws.send(json.dumps({
                "type": "extHelloAck",
                "ok": False,
                "error": "extension already connected",
            }))
            ws.close()
            return
        self.ws = ws
        try:
            for raw in ws:
                try:
                    msg = json.loads(raw)
                except Exception as e:
                    print(f"fake-hub: ignoring non-JSON frame: {e}")
                    continue
                if msg.get("type") == "extHello":
                    ws.send(json.dumps({
                        "type": "extHelloAck",
                        "ok": True,
                        "protocol": 2,
                        "sessions": self.sessions(),
                    }))
                    self.connected.set()
                elif msg.get("type") == "release":
                    # The real hub drops that client and pushes a fresh list;
                    # the extension link itself stays up.
                    self.released.set()
                    self.dropped = True
                    self.push_sessions()
                elif msg.get("type") == "response":
                    q = self.pending.pop(msg.get("rid"), None)
                    if q:
                        q.put(msg)
        finally:
            # Slot frees on disconnect, like the real hub.
            self.ws = None

    def start(self):
        self.server = serve(self._handler, "127.0.0.1", BRIDGE_PORT)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        threading.Thread(target=self._pings, daemon=True).start()

    def _pings(self):
        # Keep the MV3 service worker alive during the test.
        while True:
            time.sleep(10)
            try:
                if self.ws:
                    self.ws.send(json.dumps({"type": "ping"}))
            except Exception:
                return

    def request(self, kind, params, timeout=60):
        assert self.ws is not None, "extension not connected"
        mid = self.next_id
        self.next_id += 1
        q = queue.Queue()
        self.pending[mid] = q
        self.ws.send(json.dumps({
            "type": "request",
            "rid": mid,
            "kind": kind,
            "conversationId": self.cid,
            "params": params,
        }))
        return q.get(timeout=timeout)

    def notify_close_session(self):
        assert self.ws is not None, "extension not connected"
        self.ws.send(json.dumps({
            "type": "notify",
            "kind": "closeSession",
            "conversationId": self.cid,
        }))
        # A real /new then re-registers with a fresh conversationId and
        # the hub pushes a list without the stale one.
        self.renewed = True
        self.push_sessions()

    def disconnect(self):
        if self.ws:
            self.ws.close()
            self.ws = None


# ---------- browser driver ----------


def wait_sw(ctx, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for sw in ctx.service_workers:
            if "background.js" in sw.url:
                return sw
        time.sleep(0.5)
    raise RuntimeError("extension service worker never appeared")


def main():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), PageHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    http_port = httpd.server_address[1]
    url1 = f"http://127.0.0.1:{http_port}/page1.html"
    url2 = f"http://127.0.0.1:{http_port}/page2.html"

    fake = FakeHub(CID)
    fake.start()

    profile = tempfile.mkdtemp(prefix="pi-ext-test-")
    with sync_playwright() as p:
        # channel="chromium": Playwright's bundled Chromium runs the new
        # headless mode, which loads extensions; branded Chrome ignores
        # --load-extension in headless. --no-sandbox: unshare -Urn maps the
        # user to root, and Chrome refuses its own sandbox as uid 0.
        # DEMO=<seconds>: run headed and pause mid-test so a human can
        # inspect the toolbar icon and click it for the real popup.
        demo = float(os.environ.get("DEMO", "0"))
        ctx = p.chromium.launch_persistent_context(
            profile,
            channel="chromium",
            headless=demo <= 0,
            args=[
                f"--disable-extensions-except={EXT_DIR}",
                f"--load-extension={EXT_DIR}",
                "--no-first-run",
                "--no-sandbox",
            ],
        )
        try:
            sw = wait_sw(ctx)
            ext_id = sw.url.split("/")[2]
            check("handshake: extension connects and extHelloAck accepted",
                  fake.connected.wait(20))

            # --- feature 1: action icon state ---
            check("icon: hub link ready in SW state",
                  sw.evaluate("!!hub?.ready"))
            spy = sw.evaluate("""(async () => {
                const rec = [];
                const orig = chrome.action.setIcon.bind(chrome.action);
                try { chrome.action.setIcon = (d) => {
                    rec.push(Object.keys(d.imageData).sort().join(','));
                    return orig(d);
                }; } catch { return ['unspiable']; }
                await updateIcon();
                chrome.action.setIcon = orig;
                return rec;
            })()""")
            # The handshake's own updateIcon() can still be in flight when
            # the spy installs, so extra records are fine — every recorded
            # call must carry all four sizes.
            check("icon: updateIcon calls setIcon with all sizes",
                  len(spy) >= 1 and all(s == "128,16,32,48" for s in spy),
                  f"recorded={spy}")
            px = sw.evaluate("""(() => {
                const sample = (color, x, y) => {
                    const d = iconImageData(16, color).data;
                    const i = 4 * (y * 16 + x);
                    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
                };
                return {
                    blue: sample('#1a73e8', 8, 8),
                    gray: sample('#9aa0a6', 8, 8),
                    corner: sample('#1a73e8', 0, 0),
                };
            })()""")
            check("icon: blue dot renders blue center",
                  px["blue"] == [26, 115, 232, 255], str(px["blue"]))
            check("icon: gray dot renders gray center",
                  px["gray"] == [154, 160, 166, 255], str(px["gray"]))
            check("icon: dot corners transparent",
                  px["corner"] == [0, 0, 0, 0], str(px["corner"]))

            # --- feature 3: bridge fetch/snapshot/eval/closeGroup ---
            resp = fake.request("fetch", {"urls": [url1, url2]})
            pages = resp.get("result", {}).get("pages", [])
            check("fetch: two pages returned",
                  resp.get("ok") and len(pages) == 2,
                  json.dumps(resp)[:200] if not resp.get("ok") else "")
            check("fetch: page text extracted",
                  any("MARKER_ONE" in pg.get("text", "") for pg in pages)
                  and any("MARKER_TWO" in pg.get("text", "") for pg in pages))

            group_info = sw.evaluate("""(async () => {
                const entries = Object.entries(groups);
                if (entries.length !== 1) return { count: entries.length };
                const g = entries[0][1];
                let title = null;
                try { title = (await chrome.tabGroups.get(g.groupId)).title; }
                catch { }
                return { count: 1, key: entries[0][0], cid: g.conversationId, title };
            })()""")
            check("group: exactly one group record", group_info.get("count") == 1,
                  json.dumps(group_info))
            check("group: key is the bare conversationId",
                  group_info.get("key") == CID)
            check("group: tab group titled pi:<cid8>",
                  (group_info.get("title") or "").startswith("pi:test-con"),
                  str(group_info.get("title")))

            resp = fake.request("snapshot", {"urls": [url1]})
            snaps = resp.get("result", {}).get("snapshots", [])
            check("snapshot: page structure returned",
                  resp.get("ok") and len(snaps) == 1
                  and "to page two" in snaps[0].get("snapshot", ""),
                  json.dumps(resp)[:200] if not resp.get("ok") else "")

            resp = fake.request("eval", {"url": url1, "code": "document.title"})
            check("eval: runs in the fetched tab",
                  resp.get("ok") and resp.get("result", {}).get("result") == "Test Page One",
                  json.dumps(resp)[:200] if not resp.get("ok") else "")

            # --- feature 2: popup session list ---
            popup = ctx.new_page()
            popup.goto(f"chrome-extension://{ext_id}/popup.html")
            popup.wait_for_selector("#status.ok", timeout=10000)
            status = popup.text_content("#status") or ""
            check("popup: status shows hub and session count",
                  "Hub connected" in status and "1 session(s)" in status, status)
            items = popup.query_selector_all("#sessions li")
            check("popup: one session row", len(items) == 1)
            if items:
                row_text = items[0].inner_text()
                check("popup: row badged connected", "connected" in row_text, row_text)
                check("popup: row title is pi:<cid8>",
                      "pi:test-con" in row_text, row_text)
                check("popup: row exposes button role",
                      items[0].get_attribute("role") == "button")
            port_rows = popup.query_selector_all("#ports li")
            check("popup: session row shows owning project",
                  len(port_rows) == 1
                  and "fake-project" in port_rows[0].inner_text()
                  and "test-con" in port_rows[0].inner_text(),
                  port_rows[0].inner_text() if port_rows else "no rows")
            popup.close()

            if demo > 0:
                print(f"\nDEMO: {demo:.0f}s — toolbar 蓝点，点图标看 popup："
                      "顶部是 fake-project · test-con 会话行和 release 按钮，"
                      "下面是 pi:test-con 标签组行。可以亲手点 release，测试会跳过对应步骤\n")
                time.sleep(demo)

            # closeSession keeps the group but drops the live badge
            fake.notify_close_session()
            time.sleep(0.5)
            popup = ctx.new_page()
            popup.goto(f"chrome-extension://{ext_id}/popup.html")
            popup.wait_for_selector("#sessions li", timeout=10000)
            row = popup.query_selector("#sessions li")
            assert row is not None, "popup list is empty after closeSession"
            row_text = row.inner_text()
            check("popup: kept group badged disconnected after closeSession",
                  "disconnected" in row_text
                  and "stale" in (row.get_attribute("class") or ""), row_text)
            popup.close()

            resp = fake.request("closeGroup", {})
            check("closeGroup: reports closed",
                  resp.get("ok") and resp.get("result", {}).get("closed"),
                  json.dumps(resp)[:200])
            check("closeGroup: group record removed",
                  sw.evaluate("Object.keys(groups).length") == 0)

            # --- manual reclaim: popup release button frees the port ---
            # In DEMO mode the user may have clicked release themselves.
            if not fake.released.is_set():
                popup = ctx.new_page()
                popup.goto(f"chrome-extension://{ext_id}/popup.html")
                popup.wait_for_selector("#ports li .release", timeout=10000)
                popup.click("#ports li .release")
                popup.close()
            check("release: hub received the release command",
                  fake.released.wait(10))
            deadline = time.time() + 10
            while time.time() < deadline:
                if sw.evaluate("hubSessions.length") == 0:
                    break
                time.sleep(0.3)
            check("release: pushed sessions no longer lists the client",
                  sw.evaluate("hubSessions.length") == 0)

            # Hub shutdown drops the link: icon must go gray.
            fake.disconnect()
            deadline = time.time() + 10
            while time.time() < deadline:
                if sw.evaluate("hub === null"):
                    break
                time.sleep(0.5)
            check("icon: hub link down after disconnect",
                  sw.evaluate("hub === null"))
            sw.evaluate("updateIcon()")  # gray path must not throw
            check("icon: gray update after disconnect does not throw", True)
            if demo > 0:
                print(f"\nDEMO: {min(demo, 20):.0f}s — 连接已断开，工具栏圆点应变灰\n")
                time.sleep(min(demo, 20))

            # best-effort: real Google (no external route in the netns)
            try:
                resp = fake.request("search", {"query": "playwright", "maxResults": 3},
                                    timeout=30)
                if resp.get("ok") and resp.get("result", {}).get("results"):
                    check("search: google results", True)
                else:
                    warn("search: google unreachable/anti-bot (expected in netns)",
                         str(resp.get("error"))[:120])
            except Exception as e:
                warn("search: request failed (expected in netns)", str(e)[:120])
        finally:
            ctx.close()

    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
