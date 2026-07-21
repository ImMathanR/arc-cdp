#!/usr/bin/env node
// arc-cdp — a tiny, dependency-free Chrome DevTools Protocol client for Arc.
// Talks to whatever `arc-debug` / the LaunchAgents expose on ARC_CDP_PORT.
// It's a demo: any CDP tool (Puppeteer, Playwright, chrome-remote-interface,
// even curl) can drive the same endpoint. See the README.
//
//   arc-cdp list                  list open tabs (id prefix · title · url)
//   arc-cdp nav   <target> <url>  navigate a tab
//   arc-cdp eval  <target> <expr> run JS in a tab, print the result
//   arc-cdp shot  <target> [file] screenshot a tab to PNG
//   arc-cdp open  [url]           open a new tab
//
// <target> is a unique prefix of a targetId from `list`.

import { writeFileSync } from "node:fs";

const HOST = process.env.ARC_CDP_HOST || "127.0.0.1";
const PORT = process.env.ARC_CDP_PORT || "9223";
const BASE = `http://${HOST}:${PORT}`;

const die = (msg) => { console.error(msg); process.exit(1); };

async function pages() {
  const res = await fetch(`${BASE}/json`).catch(() => null);
  if (!res || !res.ok)
    die(`Can't reach Arc's CDP endpoint at ${BASE}.\nIs Arc running with --remote-debugging-port=${PORT}?  Check:  arc-debug-ensure status`);
  return (await res.json()).filter((t) => t.type === "page");
}

function resolve(list, prefix) {
  if (!prefix) die("Need a <target> id prefix (see `arc-cdp list`).");
  const hits = list.filter((t) => t.id.startsWith(prefix));
  if (hits.length === 0) die(`No open tab matches "${prefix}".`);
  if (hits.length > 1) die(`Ambiguous "${prefix}" — matches ${hits.length} tabs. Use more characters.`);
  return hits[0];
}

// One-shot CDP call over a tab's WebSocket.
function send(wsUrl, method, params = {}) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); rej(new Error("CDP call timed out")); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    };
    ws.onerror = () => { clearTimeout(timer); rej(new Error(`WebSocket error against ${BASE}`)); };
  });
}

const [cmd, a, b] = process.argv.slice(2);

switch (cmd) {
  case "list": {
    for (const t of await pages())
      console.log(`${t.id.slice(0, 8)}  ${(t.title || "").slice(0, 48).padEnd(48)}  ${t.url}`);
    break;
  }
  case "nav": {
    const t = resolve(await pages(), a);
    await send(t.webSocketDebuggerUrl, "Page.navigate", { url: b });
    console.log(`navigated ${t.id.slice(0, 8)} → ${b}`);
    break;
  }
  case "eval": {
    const t = resolve(await pages(), a);
    const r = await send(t.webSocketDebuggerUrl, "Runtime.evaluate", { expression: b, returnByValue: true });
    console.log(r.result?.value ?? r.result?.description ?? "(no value)");
    break;
  }
  case "shot": {
    const t = resolve(await pages(), a);
    const r = await send(t.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
    const file = b || `arc-${t.id.slice(0, 8)}.png`;
    writeFileSync(file, Buffer.from(r.data, "base64"));
    console.log(`saved ${file}`);
    break;
  }
  case "open": {
    const res = await fetch(`${BASE}/json/new?${encodeURIComponent(a || "about:blank")}`, { method: "PUT" }).catch(() => null);
    if (!res || !res.ok) die("Open a new tab failed. (Recent Chromium requires PUT on /json/new.)");
    const t = await res.json();
    console.log(`opened ${t.id.slice(0, 8)}  ${t.url}`);
    break;
  }
  default:
    console.log(`arc-cdp — tiny CDP client for Arc (endpoint ${BASE})

  arc-cdp list                  list open tabs (id prefix · title · url)
  arc-cdp nav   <target> <url>  navigate a tab
  arc-cdp eval  <target> <expr> run JS in a tab, print the result
  arc-cdp shot  <target> [file] screenshot a tab to PNG
  arc-cdp open  [url]           open a new tab

<target> is a unique id prefix from \`arc-cdp list\`.
Env: ARC_CDP_HOST (${HOST}), ARC_CDP_PORT (${PORT}).`);
}
