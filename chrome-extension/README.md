# Poracode Chrome Control

Companion browser extension that lets Poracode agents drive your **real**
Chrome / Brave / Edge — your actual tabs, cookies, and logged-in sessions. It is
the external-browser counterpart to Poracode's built-in **Browser** panel; the
two run side by side.

## How it works

```
Agent → chrome MCP server (Poracode) → localhost WebSocket → this extension → chrome.debugger (CDP) → your tabs
```

The extension holds no logic of its own: it relays Chrome DevTools Protocol
(CDP) commands from Poracode to `chrome.debugger` and forwards CDP events back.
Attaching shows Chrome's own **"Poracode started debugging this browser"** banner
on the driven tab — that banner is your consent + kill switch.

## Load it (unpacked)

In an installed Poracode app, open **Settings → Browser → Chrome extension**.
The app includes this extension and prepares a stable folder under its data
directory (normally `~/.poracode/chrome-extension`). **Open extension folder**
reveals the folder to select below. No Chrome Web Store listing is required.
When working from source, this repository's `chrome-extension/` directory can
also be loaded directly.

1. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select the folder shown by Poracode.

Install it in the profile whose tabs and signed-in sessions you want agents to
use. The bridge holds one extension connection at a time; do not load it into
every profile expecting them all to be controlled simultaneously.

That's it — no pairing, no buttons. The extension pairs with the Poracode
**app**: whenever the app is running it connects automatically and the popup
shows a green **Connected**; when the app is closed it quietly retries and
reconnects the moment the app launches again. It scans Poracode's default local
port range, so there is nothing to enter.

## Use it

Enable **Chrome** in the thread's tool menu. The agent receives a `chrome` MCP
server alongside the independent embedded `browser` server. Try:
_"Use the chrome tools: check status, list my tabs, then screenshot the active
one."_ Good first calls: `chrome_status` → `chrome_list_tabs` → `chrome_attach`
→ `chrome_snapshot` / `chrome_screenshot`.

## Security notes

- The WebSocket is bound to `127.0.0.1` and only accepts browser-extension
  origins (a web page's `http(s)` origin is rejected), so random sites can't
  reach it. A per-launch bearer token is also available for hardened setups.
- Actual control always surfaces Chrome's "started debugging this browser"
  banner — stop a session any time from there.
- `chrome_eval` and `chrome_cookies` are gated behind the same
  eval / data-access switches as the embedded browser (Poracode → Settings →
  Browser). They stay off unless you enable them.
- This drives your authenticated browser. Treat agent actions as your own.

## Current limitations

- Trusts any browser-extension-origin connection on loopback. The extension ID
  should be pinned before wider distribution.
- Available to supported native desktop providers through the per-thread Chrome
  toggle. Chrome MCP is not available to WSL threads.
- If an app update changes the extension files, click **Reload** on its card in
  `chrome://extensions` to load the updated version at the same folder path.
