#!/usr/bin/env node
// arc-cdp - lightweight Chrome DevTools Protocol CLI for the Arc browser
// Uses raw CDP over WebSocket, no Puppeteer dependency.
// Requires Node 22+ (built-in WebSocket + fetch).
//
// Adapted from pasky/chrome-cdp-skill (https://github.com/pasky/chrome-cdp-skill, MIT License,
// Copyright (c) 2026 pasky): the per-tab daemon and CDP plumbing come from its cdp.mjs.
//
// Unlike Chrome (which advertises its debug port via a DevToolsActivePort
// file), Arc is launched with a fixed remote-debugging port by the
// `arc-debug` helper script (default 9223). We discover the browser-level
// WebSocket endpoint from http://<host>:<port>/json/version.
// Override with ARC_CDP_HOST / ARC_CDP_PORT.
//
// Per-tab persistent daemon: page commands go through a daemon that holds
// the CDP session open, so repeated commands reuse one connection.
// Daemons auto-exit after 20min idle.

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { spawn } from 'child_process';
import net from 'net';
import { arcTabs, arcSpaceTitles, resolveSpace, withScheme, samePageKey, pickExisting,
  selectTab, openInSpace, tabUrl } from './arc-spaces.mjs';

const TIMEOUT = 15000;
const NAVIGATION_TIMEOUT = 30000;
const IDLE_TIMEOUT = 20 * 60 * 1000;
const DAEMON_CONNECT_RETRIES = 20;
const DAEMON_CONNECT_DELAY = 300;
const MIN_TARGET_PREFIX_LEN = 8;
const IS_WINDOWS = process.platform === 'win32';
if (!IS_WINDOWS) process.umask(0o077);
const RUNTIME_DIR = IS_WINDOWS
  ? resolve(homedir(), '.cache', 'arc-cdp')
  : process.env.XDG_RUNTIME_DIR
    ? resolve(process.env.XDG_RUNTIME_DIR, 'arc-cdp')
    : resolve(homedir(), '.cache', 'arc-cdp');
try { mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 }); } catch {}
const PAGES_CACHE = resolve(RUNTIME_DIR, 'pages.json');

// Arc's remote-debugging endpoint (launched by the `arc-debug` script).
const DEFAULT_ARC_PORT = '9223';
const ARC_HOST = process.env.ARC_CDP_HOST || '127.0.0.1';
const ARC_PORT = process.env.ARC_CDP_PORT || DEFAULT_ARC_PORT; // for display / when pinned

function sockPath(targetId) {
  return IS_WINDOWS
    ? `\\\\.\\pipe\\arc-cdp-${targetId}`
    : resolve(RUNTIME_DIR, `arc-cdp-${targetId}.sock`);
}

// Chrome advertises its debug port via a DevToolsActivePort file. Arc writes
// one too, BUT it is frequently STALE — it can point at a dead port from an
// earlier launch while the live session is elsewhere. So we treat the file as
// a *hint* only: read candidate ports from it, then verify each over HTTP
// before trusting it. The configured/default port is always tried first.
function fileDiscoveredPorts() {
  const home = homedir();
  const files = [
    process.env.ARC_CDP_PORT_FILE,
    resolve(home, 'Library/Application Support/Arc/User Data/DevToolsActivePort'),
    resolve(home, 'Library/Application Support/Arc/User Data/Default/DevToolsActivePort'),
    resolve(home, '.config/Arc/User Data/DevToolsActivePort'), // hypothetical Linux Arc
  ].filter(Boolean);
  const ports = [];
  for (const f of files) {
    try {
      if (!existsSync(f)) continue;
      const port = parseInt(readFileSync(f, 'utf8').trim().split('\n')[0], 10);
      if (port > 0) ports.push(String(port));
    } catch {}
  }
  return ports;
}

// Probe one port's /json/version; return its browser WebSocket URL or null.
async function probePort(port) {
  try {
    const res = await fetch(`http://${ARC_HOST}:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const info = await res.json();
    return info.webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

async function getWsUrl() {
  // If the user pinned ARC_CDP_PORT, honor it strictly. Otherwise try the
  // default port first, then any (verified) port from Arc's DevToolsActivePort.
  const candidates = process.env.ARC_CDP_PORT
    ? [process.env.ARC_CDP_PORT]
    : [...new Set([DEFAULT_ARC_PORT, ...fileDiscoveredPorts()])];

  for (const port of candidates) {
    const wsRaw = await probePort(port);
    if (wsRaw) {
      // Arc reports e.g. ws://localhost:9223/devtools/browser/<id>; pin it to
      // the host/port we actually reached so a custom ARC_CDP_HOST still works.
      const ws = new URL(wsRaw);
      ws.host = `${ARC_HOST}:${port}`;
      return ws.toString();
    }
  }

  throw new Error(
    `Cannot reach Arc's remote-debugging port (tried ${candidates.join(', ')} on ${ARC_HOST}).\n` +
    `Start Arc with debugging enabled:\n` +
    `  1. Fully quit Arc (Cmd-Q) — a normally-launched Arc ignores the flag.\n` +
    `  2. Run:  arc-debug\n` +
    `(pin a port with ARC_CDP_PORT, or point ARC_CDP_PORT_FILE at a DevToolsActivePort file)`
  );
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));


function resolvePrefix(prefix, candidates, noun = 'target', missingHint = '') {
  const upper = prefix.toUpperCase();
  const matches = candidates.filter(candidate => candidate.toUpperCase().startsWith(upper));
  if (matches.length === 0) {
    const hint = missingHint ? ` ${missingHint}` : '';
    throw new Error(`No ${noun} matching prefix "${prefix}".${hint}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`);
  }
  return matches[0];
}

function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
  const maxLen = Math.max(...targetIds.map(id => id.length));
  for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len++) {
    const prefixes = new Set(targetIds.map(id => id.slice(0, len).toUpperCase()));
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}

// ---------------------------------------------------------------------------
// CDP WebSocket client
// ---------------------------------------------------------------------------

class CDP {
  #ws; #id = 0; #pending = new Map(); #eventHandlers = new Map(); #closeHandlers = [];

  async connect(wsUrl) {
    return new Promise((res, rej) => {
      this.#ws = new WebSocket(wsUrl);
      this.#ws.onopen = () => res();
      this.#ws.onerror = (e) => rej(new Error('WebSocket error: ' + (e.message || e.type)));
      this.#ws.onclose = () => this.#closeHandlers.forEach(h => h());
      this.#ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.#pending.has(msg.id)) {
          const { resolve, reject } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        } else if (msg.method && this.#eventHandlers.has(msg.method)) {
          for (const handler of [...this.#eventHandlers.get(msg.method)]) {
            handler(msg.params || {}, msg);
          }
        }
      };
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.#ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, TIMEOUT);
    });
  }

  onEvent(method, handler) {
    if (!this.#eventHandlers.has(method)) this.#eventHandlers.set(method, new Set());
    const handlers = this.#eventHandlers.get(method);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#eventHandlers.delete(method);
    };
  }

  waitForEvent(method, timeout = TIMEOUT) {
    let settled = false;
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
      },
    };
  }

  onClose(handler) { this.#closeHandlers.push(handler); }
  close() { this.#ws.close(); }
}

// ---------------------------------------------------------------------------
// Command implementations — return strings, take (cdp, sessionId)
// ---------------------------------------------------------------------------

async function getPages(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('chrome://'));
}

function formatPageList(pages) {
  const prefixLen = getDisplayPrefixLength(pages.map(p => p.targetId));
  return pages.map(p => {
    const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const title = p.title.substring(0, 54).padEnd(54);
    return `${id}  ${title}  ${p.url}`;
  }).join('\n');
}

function shouldShowAxNode(node, compact = false) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  return role !== 'none' && role !== 'generic' && !(name === '' && (value === '' || value == null));
}

function formatAxNode(node, depth) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));
  let line = `${indent}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
  return line;
}

function orderedAxChildren(node, nodesById, childrenByParent) {
  const children = [];
  const seen = new Set();
  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  return children;
}

async function snapshotStr(cdp, sid, compact = false) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sid);
  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  const lines = [];
  const visited = new Set();
  function visit(node, depth) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShowAxNode(node, compact)) lines.push(formatAxNode(node, depth));
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1);
    }
  }

  const roots = nodes.filter(node => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  return lines.join('\n');
}

async function evalStr(cdp, sid, expression) {
  await cdp.send('Runtime.enable', {}, sid);
  const result = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description);
  }
  const val = result.result.value;
  return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? '');
}

async function shotStr(cdp, sid, filePath, targetId) {
  // Get device scale factor so we can report coordinate mapping
  let dpr = 1;
  try {
    const metrics = await cdp.send('Page.getLayoutMetrics', {}, sid);
    dpr = metrics.visualViewport?.clientWidth
      ? metrics.cssVisualViewport?.clientWidth
        ? Math.round((metrics.visualViewport.clientWidth / metrics.cssVisualViewport.clientWidth) * 100) / 100
        : 1
      : 1;
    // Simpler: deviceScaleFactor is on the root Page metrics
    const { deviceScaleFactor } = await cdp.send('Emulation.getDeviceMetricsOverride', {}, sid).catch(() => ({}));
    if (deviceScaleFactor) dpr = deviceScaleFactor;
  } catch {}
  // Fallback: try to get DPR from JS
  if (dpr === 1) {
    try {
      const raw = await evalStr(cdp, sid, 'window.devicePixelRatio');
      const parsed = parseFloat(raw);
      if (parsed > 0) dpr = parsed;
    } catch {}
  }

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  const out = filePath || resolve(RUNTIME_DIR, `screenshot-${(targetId || 'unknown').slice(0, 8)}.png`);
  writeFileSync(out, Buffer.from(data, 'base64'));

  const lines = [out];
  lines.push(`Screenshot saved. Device pixel ratio (DPR): ${dpr}`);
  lines.push(`Coordinate mapping:`);
  lines.push(`  Screenshot pixels → CSS pixels (for CDP Input events): divide by ${dpr}`);
  lines.push(`  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200) → use clickxy <target> 100 200`);
  if (dpr !== 1) {
    lines.push(`  On this ${dpr}x display: CSS px = screenshot px / ${dpr} ≈ screenshot px × ${Math.round(100/dpr)/100}`);
  }
  return lines.join('\n');
}

async function htmlStr(cdp, sid, selector) {
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
    : `document.documentElement.outerHTML`;
  return evalStr(cdp, sid, expr);
}

async function waitForDocumentReady(cdp, sid, timeoutMs = NAVIGATION_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let lastState = '';
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await evalStr(cdp, sid, 'document.readyState');
      lastState = state;
      if (state === 'complete') return;
    } catch (e) {
      lastError = e;
    }
    await sleep(200);
  }

  if (lastState) {
    throw new Error(`Timed out waiting for navigation to finish (last readyState: ${lastState})`);
  }
  if (lastError) {
    throw new Error(`Timed out waiting for navigation to finish (${lastError.message})`);
  }
  throw new Error('Timed out waiting for navigation to finish');
}

async function navStr(cdp, sid, url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      throw new Error(`Only http/https URLs allowed, got: ${url}`);
  } catch (e) {
    if (e.message.startsWith('Only')) throw e;
    throw new Error(`Invalid URL: ${url}`);
  }
  await cdp.send('Page.enable', {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  const result = await cdp.send('Page.navigate', { url }, sid);
  if (result.errorText) {
    loadEvent.cancel();
    throw new Error(result.errorText);
  }
  if (result.loaderId) {
    await loadEvent.promise;
  } else {
    loadEvent.cancel();
  }
  await waitForDocumentReady(cdp, sid, 5000);
  return `Navigated to ${url}`;
}

async function netStr(cdp, sid) {
  const raw = await evalStr(cdp, sid, `JSON.stringify(performance.getEntriesByType('resource').map(e => ({
    name: e.name.substring(0, 120), type: e.initiatorType,
    duration: Math.round(e.duration), size: e.transferSize
  })))`);
  return JSON.parse(raw).map(e =>
    `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${e.type.padEnd(8)}  ${e.name}`
  ).join('\n');
}

// Click element by CSS selector
async function clickStr(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  return `Clicked <${r.tag}> "${r.text}"`;
}

// Click at CSS pixel coordinates using Input.dispatchMouseEvent
async function clickXyStr(cdp, sid, x, y) {
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  const base = { x: cx, y: cy, button: 'left', clickCount: 1, modifiers: 0 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, sid);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sid);
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sid);
  return `Clicked at CSS (${cx}, ${cy})`;
}

// Type text using Input.insertText (works in cross-origin iframes, unlike eval)
async function typeStr(cdp, sid, text) {
  if (text == null || text === '') throw new Error('text required');
  await cdp.send('Input.insertText', { text }, sid);
  return `Typed ${text.length} characters`;
}

// Load-more: repeatedly click a button/selector until it disappears
async function loadAllStr(cdp, sid, selector, intervalMs = 1500) {
  if (!selector) throw new Error('CSS selector required');
  let clicks = 0;
  const deadline = Date.now() + 5 * 60 * 1000; // 5-minute hard cap
  while (Date.now() < deadline) {
    const exists = await evalStr(cdp, sid,
      `!!document.querySelector(${JSON.stringify(selector)})`
    );
    if (exists !== 'true') break;
    const clickExpr = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()
    `;
    const clicked = await evalStr(cdp, sid, clickExpr);
    if (clicked !== 'true') break;
    clicks++;
    await sleep(intervalMs);
  }
  return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
}

// Send a raw CDP command and return the result as JSON
async function evalRawStr(cdp, sid, method, paramsJson) {
  if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');
  let params = {};
  if (paramsJson) {
    try { params = JSON.parse(paramsJson); }
    catch { throw new Error(`Invalid JSON params: ${paramsJson}`); }
  }
  const result = await cdp.send(method, params, sid);
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Per-tab daemon
// ---------------------------------------------------------------------------

async function runDaemon(targetId) {
  const sp = sockPath(targetId);

  const cdp = new CDP();
  try {
    await cdp.connect(await getWsUrl());
  } catch (e) {
    process.stderr.write(`Daemon: cannot connect to Arc: ${e.message}\n`);
    process.exit(1);
  }

  let sessionId;
  try {
    const res = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = res.sessionId;
  } catch (e) {
    process.stderr.write(`Daemon: attach failed: ${e.message}\n`);
    cdp.close();
    process.exit(1);
  }

  // Shutdown helpers
  let alive = true;
  function shutdown() {
    if (!alive) return;
    alive = false;
    server.close();
    if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
    cdp.close();
    process.exit(0);
  }

  // Exit if target goes away or Chrome disconnects
  cdp.onEvent('Target.targetDestroyed', (params) => {
    if (params.targetId === targetId) shutdown();
  });
  cdp.onEvent('Target.detachedFromTarget', (params) => {
    if (params.sessionId === sessionId) shutdown();
  });
  cdp.onClose(() => shutdown());
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Idle timer
  let idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  }

  // Handle a command
  async function handleCommand({ cmd, args }) {
    resetIdle();
    try {
      let result;
      switch (cmd) {
        case 'list': {
          const pages = await getPages(cdp);
          result = formatPageList(pages);
          break;
        }
        case 'list_raw': {
          const pages = await getPages(cdp);
          result = JSON.stringify(pages);
          break;
        }
        case 'snap': case 'snapshot': result = await snapshotStr(cdp, sessionId, true); break;
        case 'eval': result = await evalStr(cdp, sessionId, args[0]); break;
        case 'shot': case 'screenshot': result = await shotStr(cdp, sessionId, args[0], targetId); break;
        case 'html': result = await htmlStr(cdp, sessionId, args[0]); break;
        case 'nav': case 'navigate': result = await navStr(cdp, sessionId, args[0]); break;
        case 'net': case 'network': result = await netStr(cdp, sessionId); break;
        case 'click': result = await clickStr(cdp, sessionId, args[0]); break;
        case 'clickxy': result = await clickXyStr(cdp, sessionId, args[0], args[1]); break;
        case 'type': result = await typeStr(cdp, sessionId, args[0]); break;
        case 'loadall': result = await loadAllStr(cdp, sessionId, args[0], args[1] ? parseInt(args[1]) : 1500); break;
        case 'evalraw': result = await evalRawStr(cdp, sessionId, args[0], args[1]); break;
        case 'stop': return { ok: true, result: '', stopAfter: true };
        default: return { ok: false, error: `Unknown command: ${cmd}` };
      }
      return { ok: true, result: result ?? '' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Unix socket server — NDJSON protocol
  // Wire format: each message is one JSON object followed by \n (newline-delimited JSON).
  // Request:  { "id": <number>, "cmd": "<command>", "args": ["arg1", "arg2", ...] }
  // Response: { "id": <number>, "ok": <boolean>, "result": "<string>" }
  //           or { "id": <number>, "ok": false, "error": "<message>" }
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          conn.write(JSON.stringify({ ok: false, error: 'Invalid JSON request', id: null }) + '\n');
          continue;
        }
        handleCommand(req).then((res) => {
          const payload = JSON.stringify({ ...res, id: req.id }) + '\n';
          if (res.stopAfter) conn.end(payload, shutdown);
          else conn.write(payload);
        });
      }
    });
  });

  if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
  server.listen(sp);
}

// ---------------------------------------------------------------------------
// CLI ↔ daemon communication
// ---------------------------------------------------------------------------

function connectToSocket(sp) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sp);
    conn.on('connect', () => resolve(conn));
    conn.on('error', reject);
  });
}

async function getOrStartTabDaemon(targetId) {
  const sp = sockPath(targetId);
  // Try existing daemon
  try { return await connectToSocket(sp); } catch {}

  // Clean stale socket
  if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}

  // Spawn daemon
  const child = spawn(process.execPath, [process.argv[1], '_daemon', targetId], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Wait for socket (includes time for user to click Allow)
  for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
    await sleep(DAEMON_CONNECT_DELAY);
    try { return await connectToSocket(sp); } catch {}
  }
  throw new Error('Daemon failed to start — is Arc running via `arc-debug` on port ' + ARC_PORT + '?');
}

function sendCommand(conn, req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;

    const cleanup = () => {
      conn.off('data', onData);
      conn.off('error', onError);
      conn.off('end', onEnd);
      conn.off('close', onClose);
    };

    const onData = (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      settled = true;
      cleanup();
      resolve(JSON.parse(buf.slice(0, idx)));
      conn.end();
    };

    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    conn.on('data', onData);
    conn.on('error', onError);
    conn.on('end', onEnd);
    conn.on('close', onClose);
    req.id = 1;
    conn.write(JSON.stringify(req) + '\n');
  });
}

// ---------------------------------------------------------------------------
// Stop daemons
// ---------------------------------------------------------------------------

async function stopDaemons(targetPrefix) {
  if (!existsSync(PAGES_CACHE)) return;
  const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
  const targets = targetPrefix
    ? [resolvePrefix(targetPrefix, pages.map(p => p.targetId), 'target')]
    : pages.map(p => p.targetId);

  for (const targetId of targets) {
    const sp = sockPath(targetId);
    try {
      const conn = await connectToSocket(sp);
      await sendCommand(conn, { cmd: 'stop' });
    } catch {
      if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `arc-cdp - lightweight Chrome DevTools Protocol CLI for Arc (no Puppeteer)

Connects to Arc launched via the \`arc-debug\` script (remote-debugging port
${ARC_PORT} by default; override with ARC_CDP_HOST / ARC_CDP_PORT).

Usage: arc-cdp <command> [args]

  list                              List open pages (shows unique target prefixes)
  snap  <target>                    Accessibility tree snapshot
  eval  <target> <expr>             Evaluate JS expression
  shot  <target> [file]             Screenshot (default: screenshot-<target>.png in runtime dir); prints coordinate mapping
  html  <target> [selector]         Get HTML (full page or CSS selector)
  nav   <target> <url>              Navigate to URL and wait for load completion
  net   <target>                    Network performance entries
  click   <target> <selector>       Click an element by CSS selector
  clickxy <target> <x> <y>          Click at CSS pixel coordinates (see coordinate note below)
  type    <target> <text>           Type text at current focus via Input.insertText
                                    Works in cross-origin iframes unlike eval-based approaches
  loadall <target> <selector> [ms]  Repeatedly click a "load more" button until it disappears
                                    Optional interval in ms between clicks (default 1500)
  evalraw <target> <method> [json]  Send a raw CDP command; returns JSON result
                                    e.g. evalraw <t> "DOM.getDocument" '{}'
  open  <url> [--space per|work|<name>] [--new]
                                    Reuse the tab already showing <url> in that space
                                    (selects it), else open it there. Prints the target.
                                    per = Personal, work = Work. --new always opens a new tab.
  tabs                              Every Arc tab by space (incl. not-yet-loaded ones)
  stop  [target]                    Stop daemon(s)

<target> is a unique targetId prefix from "arc-cdp list". If a prefix is
ambiguous, use more characters.

COORDINATE SYSTEM
  shot captures the viewport at the device's native resolution.
  The screenshot image size = CSS pixels × DPR (device pixel ratio).
  For CDP Input events (clickxy, etc.) you need CSS pixels, not image pixels.

    CSS pixels = screenshot image pixels / DPR

  shot prints the DPR and an example conversion for the current page.
  Typical Retina (DPR=2): CSS px ≈ screenshot px × 0.5
  If your viewer rescales the image further, account for that scaling too.

EVAL SAFETY NOTE
  Avoid index-based DOM selection (querySelectorAll(...)[i]) across multiple
  eval calls when the list can change between calls (e.g. after clicking
  "Ignore" buttons on a feed — indices shift). Prefer stable selectors or
  collect all data in a single eval.

DAEMON IPC (for advanced use / scripting)
  Each tab runs a persistent daemon at Unix socket in the runtime dir (see below).
  Protocol: newline-delimited JSON (one JSON object per line, UTF-8).
    Request:  {"id":<number>, "cmd":"<command>", "args":["arg1","arg2",...]}
    Response: {"id":<number>, "ok":true,  "result":"<string>"}
           or {"id":<number>, "ok":false, "error":"<message>"}
  Commands mirror the CLI: snap, eval, shot, html, nav, net, click, clickxy,
  type, loadall, evalraw, stop. Use evalraw to send arbitrary CDP methods.
  The socket disappears after 20 min of inactivity or when the tab closes.
`;

const NEEDS_TARGET = new Set([
  'snap','snapshot','eval','shot','screenshot','html','nav','navigate',
  'net','network','click','clickxy','type','loadall','evalraw',
]);

function parseOpenArgs(args) {
  const opts = { url: null, space: null, new: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--space') opts.space = args[++i];
    else if (args[i].startsWith('--space=')) opts.space = args[i].slice(8);
    else if (args[i] === '--new') opts.new = true;
    else if (!opts.url) opts.url = args[i];
  }
  return opts;
}

/** The CDP page for a tab just opened or selected: a newly appeared target, else a URL match. */
async function findTarget(cdp, before, currentUrl, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let pages = [];
  while (Date.now() < deadline) {
    pages = await getPages(cdp);
    const fresh = pages.filter(p => !before.has(p.targetId));
    if (fresh.length === 1) return { page: fresh[0], pages };
    const key = samePageKey(currentUrl());
    const freshMatch = fresh.find(p => samePageKey(p.url) === key);
    if (freshMatch) return { page: freshMatch, pages };
    const same = pages.filter(p => samePageKey(p.url) === key);
    if (same.length && !fresh.length) return { page: same[0], pages, ambiguous: same.length > 1 };
    await new Promise(r => setTimeout(r, 250));
  }
  return { page: null, pages };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  // Daemon mode (internal)
  if (cmd === '_daemon') { await runDaemon(args[0]); return; }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE); process.exit(0);
  }

  if (cmd === 'list' || cmd === 'ls') {
    const cdp = new CDP();
    await cdp.connect(await getWsUrl());
    const pages = await getPages(cdp);
    cdp.close();
    writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
    console.log(formatPageList(pages));
    setTimeout(() => process.exit(0), 100);
    return;
  }

  // Open a page: reuse the tab already showing it (in the requested space), else open it there
  if (cmd === 'open') {
    const opts = parseOpenArgs(args);
    const url = withScheme(opts.url || 'about:blank');
    const { active, tabs } = arcTabs();
    const space = resolveSpace(opts.space, arcSpaceTitles());
    const cdp = new CDP();
    await cdp.connect(await getWsUrl());
    const before = new Set((await getPages(cdp)).map(p => p.targetId));
    const { tab, elsewhere } = opts.new || !opts.url ? { tab: null, elsewhere: [] }
      : pickExisting(tabs, url, space, active);
    let verb, where, arcId;
    if (tab) {
      selectTab(tab.space, tab.id);
      [verb, where, arcId] = ['Reused open tab', tab.space, tab.id];
    } else {
      where = space || active;
      arcId = openInSpace(where, url);
      verb = 'Opened new tab';
    }
    const found = await findTarget(cdp, before, () => (tab ? tabUrl(arcId) : url));
    cdp.close();
    writeFileSync(PAGES_CACHE, JSON.stringify(found.pages), { mode: 0o600 });
    if (found.page) {
      const len = getDisplayPrefixLength(found.pages.map(p => p.targetId));
      console.log(`${verb} in ${where}: ${found.page.targetId.slice(0, len)}  ${found.page.title}  ${found.page.url}`);
      if (found.ambiguous) console.log('Note: several loaded tabs show this URL; run "arc-cdp list" to double-check the target.');
    } else {
      console.log(`${verb} in ${where} (Arc tab ${arcId}), but it isn't visible to CDP yet. Run "arc-cdp list" in a moment.`);
    }
    for (const t of elsewhere) console.log(`Also open in ${t.space} (not reused: different space): ${t.title}`);
    return;
  }

  // Every Arc tab, grouped by space, with its CDP target when loaded
  if (cmd === 'tabs') {
    const { active, tabs } = arcTabs();
    const cdp = new CDP();
    await cdp.connect(await getWsUrl());
    const pages = await getPages(cdp);
    cdp.close();
    writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
    const len = getDisplayPrefixLength(pages.map(p => p.targetId));
    let last = null;
    for (const t of tabs) {
      if (t.space !== last) console.log(`\n${t.space}${t.space === active ? '  (active)' : ''}`);
      last = t.space;
      const page = pages.find(p => samePageKey(p.url) === samePageKey(t.url));
      const target = page ? page.targetId.slice(0, len) : '-'.padEnd(len);
      console.log(`  ${target}  ${t.title.substring(0, 50).padEnd(50)}  ${t.url}`);
    }
    console.log('\n"-" = not loaded yet; "open <url> --space ..." loads and selects it.');
    setTimeout(() => process.exit(0), 100);
    return;
  }

  // Stop
  if (cmd === 'stop') {
    await stopDaemons(args[0]);
    return;
  }

  // Page commands — need target prefix
  if (!NEEDS_TARGET.has(cmd)) {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  const targetPrefix = args[0];
  if (!targetPrefix) {
    console.error('Error: target ID required. Run "cdp list" first.');
    process.exit(1);
  }

  // Resolve prefix → full targetId from pages cache
  if (!existsSync(PAGES_CACHE)) {
    console.error('No page list cached. Run "cdp list" first.');
    process.exit(1);
  }
  const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
  const targetId = resolvePrefix(targetPrefix, pages.map(p => p.targetId), 'target', 'Run "cdp list".');

  const conn = await getOrStartTabDaemon(targetId);

  const cmdArgs = args.slice(1);

  if (cmd === 'eval') {
    const expr = cmdArgs.join(' ');
    if (!expr) { console.error('Error: expression required'); process.exit(1); }
    cmdArgs[0] = expr;
  } else if (cmd === 'type') {
    // Join all remaining args as text (allows spaces)
    const text = cmdArgs.join(' ');
    if (!text) { console.error('Error: text required'); process.exit(1); }
    cmdArgs[0] = text;
  } else if (cmd === 'evalraw') {
    // args: [method, ...jsonParts] — join json parts in case of spaces
    if (!cmdArgs[0]) { console.error('Error: CDP method required'); process.exit(1); }
    if (cmdArgs.length > 2) cmdArgs[1] = cmdArgs.slice(1).join(' ');
  }

  if ((cmd === 'nav' || cmd === 'navigate') && !cmdArgs[0]) {
    console.error('Error: URL required');
    process.exit(1);
  }

  const response = await sendCommand(conn, { cmd, args: cmdArgs });

  if (response.ok) {
    if (response.result) console.log(response.result);
  } else {
    console.error('Error:', response.error);
    process.exitCode = 1;
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
