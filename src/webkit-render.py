#!/usr/bin/env python3
"""Render one URL with WebKit2GTK and print the result as JSON on stdout.

Usage: webkit-render.py <url> <timeout-seconds> <settle-ms>

Loads the page in a WebKit2 WebView (JS enabled, no GPU), waits for the load
to finish plus a settle delay for client-side rendering, extracts
document.body.innerText, and prints {"ok": bool, "text": str, "error": str|None}.
On overall timeout it extracts whatever is loaded so far.
"""

import json
import re
import sys
from urllib.parse import urlparse

import gi  # type: ignore[import-not-found] # Linux-only system package (PyGObject)

gi.require_version("WebKit2", "4.1")
gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402,I001  # type: ignore[import-untyped]

url = sys.argv[1]
try:
    timeout_s = float(sys.argv[2])
    settle_ms = int(sys.argv[3])
    timeout_int = max(1, int(timeout_s))
except (IndexError, ValueError):
    print(json.dumps({"ok": False, "text": "", "error": "bad args"}))
    sys.exit(2)

# Same internal-host policy as validateUrl in text.ts: loopback, RFC1918,
# link-local, ULA, IPv4-mapped IPv6, cloud metadata. urlparse lowercases
# the hostname and strips IPv6 brackets.
BLOCKED_HOST = re.compile(
    r"^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\."
    r"|169\.254\.|metadata\.google\.internal"
    r"|::|fe[89ab][0-9a-f]|f[cd][0-9a-f]{2})",
    re.I,
)

result = {"ok": False, "text": "", "error": None}
done = False


def finish():
    global done
    if done:
        return
    done = True
    Gtk.main_quit()


def on_js(view, res, _):
    global done
    try:
        value = view.run_javascript_finish(res).get_js_value()
        result["text"] = value.to_string()
        result["ok"] = bool(result["text"].strip())
        if not result["ok"]:
            result["error"] = "empty body"
    except Exception as e:  # noqa: BLE001
        result["error"] = str(e)
    finish()


def extract():
    view.run_javascript(
        "document.body ? document.body.innerText : ''", None, on_js, None
    )
    return False


def on_load_changed(view, event):
    if event == WebKit2.LoadEvent.COMMITTED:
        # Redirects re-enter the load cycle with the new URI — check the
        # committed main-frame URL before any content is rendered, since
        # WebKit followed the redirect without consulting validateUrl.
        # Subresources to internal hosts still load; only the document is
        # gated here.
        host = urlparse(view.get_uri() or "").hostname or ""
        if BLOCKED_HOST.search(host) or host.endswith(".localhost"):
            result["error"] = f"refusing internal host: {host}"
            view.stop_loading()
            finish()
    elif event == WebKit2.LoadEvent.FINISHED:
        GLib.timeout_add(settle_ms, extract)


def on_load_failed(view, event, uri, error):
    if done:
        return False
    result["error"] = error.message
    finish()
    return False


def on_timeout():
    if done:
        return False
    # Extract whatever has loaded so far rather than failing outright.
    extract()
    return False


window = Gtk.Window()
window.set_default_size(1280, 900)
view = WebKit2.WebView()
settings = view.get_settings()
settings.set_enable_javascript(True)
settings.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)
view.connect("load-changed", on_load_changed)
view.connect("load-failed", on_load_failed)
window.add(view)
# The window stays unmapped: DOM loading and JS execution do not require
# the widget to be visible, and unmapped avoids flashing windows on the
# user's desktop.
GLib.timeout_add_seconds(timeout_int, on_timeout)
view.load_uri(url)
Gtk.main()

print(json.dumps(result))
sys.exit(0 if result["ok"] else 1)
