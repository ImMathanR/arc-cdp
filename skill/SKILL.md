---
name: arc
description: Open, check, inspect and drive web pages in the Arc browser via the Chrome DevTools Protocol, in the right Arc space ("per" = Personal, "work" = Work), reusing a tab that already shows the page instead of opening a duplicate (only after the user asks to open, look at, check, debug, or drive a page in Arc; requires Arc launched with `arc-debug`).
---

# Arc CDP

Lightweight Chrome DevTools Protocol CLI for the **Arc** browser. Connects
directly over WebSocket — no Puppeteer, works with 100+ tabs, instant
connection. Arc is Chromium-based, so the same CDP commands as `/chrome-cdp`
apply; the only difference is how the debug endpoint is discovered.

The engine lives at `~/.claude/skills/arc/scripts/arc-cdp.mjs`. Below it is
referred to as `arc-cdp`; run it with `node ~/.claude/skills/arc/scripts/arc-cdp.mjs <command>`.

## Prerequisites

Arc must be running with remote debugging enabled on port 9223. This is
**set up to happen automatically** on this machine — just launch Arc normally
(Spotlight / Dock):

- `com.arc.debug-launch` LaunchAgent starts Arc with `--remote-debugging-port=9223`
  at login.
- `com.arc.debug-heal` LaunchAgent runs `~/.local/bin/arc-debug-ensure` every
  ~30s and, if Arc is running *without* the debug port (e.g. just after a
  Sparkle auto-update relaunched it plainly), gracefully quits and relaunches
  it with the flag.

So normally there's nothing to do. Confirm it's live with
`curl -s http://localhost:9223/json/version`.

If `arc-cdp list` reports the port unreachable, debug isn't up yet. Either
wait ~30s for the heal agent, or have the user trigger it. Don't quit/relaunch
their browser yourself without asking; instead suggest they run, in the prompt:

- `! arc-debug-ensure heal` — relaunch the running Arc with the flag now, or
- `! arc-debug` — fully manual launch with the flag.

- Node.js 22+ (built-in `WebSocket` + `fetch`).
- Default endpoint is `127.0.0.1:9223`. Override with `ARC_CDP_HOST` /
  `ARC_CDP_PORT` (these must match the LaunchAgents if you change the port).

## Opening or checking a page: always `open --space`

Whenever you are asked to open, check, look at or test a web page, get to it
with `open`, never by creating a tab yourself or navigating some other tab:

```bash
arc-cdp open <url> --space per     # per  -> the Personal space
arc-cdp open <url> --space work    # work -> the Work space
```

- **Space comes from the user.** They say "per" or "work" with the request;
  pass it through as `--space`. If they didn't say which, ask ("per or
  work?") before opening anything. Other space names work too (exact title).
- **Reuse, don't duplicate.** `open` first looks through every Arc tab,
  including ones not loaded since a relaunch. If the page is already open in
  that space (same URL, ignoring http/https, a trailing slash and `#fragment`),
  it switches to that space, selects the tab and takes control of it. Only
  when it isn't open there does it open a new tab in that space.
- **Other space, other account.** A copy open only in the *other* space is not
  reused (spaces can be signed in to different accounts); `open` opens it in
  the requested space and prints `Also open in <space>`.
- It prints the target to use for everything else, e.g.
  `Reused open tab in Work: F20103DA  Title  URL`; run `shot`, `snap`,
  `eval`, `click` … against that prefix.
- `--new` forces a fresh tab even when one exists; use it only when the user
  asks for a second copy.
- `arc-cdp tabs` lists every Arc tab by space with its target prefix
  (`-` = not loaded yet; `open` loads and selects it).

## Commands

The `<target>` is a **unique** targetId prefix from `list`; copy the full
prefix shown in the `list` output (for example `054A19BF`). The CLI rejects
ambiguous prefixes — add more characters.

### List open pages

```bash
arc-cdp list
```

### Take a screenshot

```bash
arc-cdp shot <target> [file]    # default: screenshot-<target>.png in runtime dir
```

Captures the **viewport only**. Scroll first with `eval` if you need content
below the fold. Output includes the page's DPR and a coordinate conversion
hint (see **Coordinates** below).

### Accessibility tree snapshot

```bash
arc-cdp snap <target>
```

### Evaluate JavaScript

```bash
arc-cdp eval <target> <expr>
```

> **Watch out:** avoid index-based selection (`querySelectorAll(...)[i]`)
> across multiple `eval` calls when the DOM can change between them. Collect
> all data in one `eval` or use stable selectors.

### Other commands

```bash
arc-cdp html    <target> [selector]    # full page or element HTML
arc-cdp nav     <target> <url>          # navigate and wait for load
arc-cdp net     <target>                # resource timing entries
arc-cdp click   <target> <selector>     # click element by CSS selector
arc-cdp clickxy <target> <x> <y>        # click at CSS pixel coords
arc-cdp type    <target> <text>          # Input.insertText at current focus; works in cross-origin iframes
arc-cdp loadall <target> <selector> [ms] # click "load more" until gone (default 1500ms between clicks)
arc-cdp evalraw <target> <method> [json] # raw CDP command passthrough
arc-cdp open    <url> --space per|work  # reuse the tab showing <url> in that space, else open it there
arc-cdp tabs                            # every Arc tab by space, incl. not-yet-loaded ones
arc-cdp stop    [target]                # stop daemon(s)
```

## Coordinates

`shot` saves an image at native resolution: image pixels = CSS pixels × DPR.
CDP Input events (`clickxy` etc.) take **CSS pixels**.

```
CSS px = screenshot image px / DPR
```

`shot` prints the DPR for the current page. Typical Retina (DPR=2): divide
screenshot coords by 2.

## Tips

- Prefer `snap` over `html` for page structure — it's far more compact.
- Use `type` (not eval) to enter text in cross-origin iframes — `click`/
  `clickxy` to focus first, then `type`.
- The first command against a tab spawns a background daemon that holds the
  CDP session open, so subsequent commands on that tab are instant. Daemons
  auto-exit after 20 minutes of inactivity, or when the tab closes, or via
  `arc-cdp stop`.
- This skill and `/chrome-cdp` are isolated (separate runtime dirs and
  sockets), so you can drive Arc and Chrome at the same time.

## Goal-driven browsing with Jev (`jev-browse.py`)

For "go and do X in a browser" rather than hand-driving CDP, use the decision-model loop. It observes the
accessibility tree, asks Jev one typed request per step (which operation, which element, what to type — only the
winning branch is read), acts through `agent-browser`, and returns DONE / BLOCKED / LIMIT. No LLM in the loop:
~0.6 s and ~$0.0003 per decision, and text entry selects a span of the goal rather than generating one.

```bash
B=~/.claude/skills/arc/scripts/jev-browse.py

# private browser (default) — safe for unattended runs
python3 $B "Open the Issues tab, then open the first issue" --start https://github.com/browser-use/jev-ultrafast

# the user's live Arc, with their logins — only when the task needs a signed-in session
python3 $B "Find the pricing page and report the team plan price" --arc
```

Measured on this machine (2 tasks x 2 runs): 3-4 steps, 8-13 s, $0.001 per task, same success as Claude Sonnet 5
making the same decisions but ~2x faster end to end and ~25x cheaper. The floor is the snapshot (~0.5 s) and page
loads, not the model.

Two rules from those runs:
- **Default to the private session.** With `--arc`, another tab taking focus moves agent-browser's current page
  and the loop finishes somewhere else. Use `--arc` only when you need the user's logins, and watch it.
- **It is bounded, not autonomous.** Give it one concrete subtask with a visible success condition; it stops at
  `--max-steps` (default 20). For anything irreversible (posting, buying, deleting), drive it yourself.

The decision client, its rules and the standalone `jev` CLI live in the `jev` skill.
