---
name: arc
description: Inspect and drive pages open in the Arc browser over the Chrome DevTools Protocol — list tabs, navigate, run JS, screenshot. Use when the user asks to look at, screenshot, debug, or drive a page in Arc. Requires the arc-cdp launch agents (this plugin's install.sh) so Arc is always reachable on the debug port.
---

# arc — drive the Arc browser over CDP

Arc is Chromium and speaks the Chrome DevTools Protocol. This plugin's launch
agents keep Arc listening on `http://127.0.0.1:9223` and re-add the flag after
Arc auto-updates — so you can attach to the user's real Arc tabs the same way
`/chrome-cdp` attaches to Chrome.

The client sits next to this file at `scripts/arc-cdp.mjs` (Node 22+, no deps):

```bash
node ~/.claude/skills/arc/scripts/arc-cdp.mjs <command>
```

## Commands

- `list` — list open tabs as `<id prefix>  <title>  <url>`. **Run this first.**
- `nav  <target> <url>` — navigate a tab.
- `eval <target> <expr>` — run JS in a tab, print the result.
- `shot <target> [file]` — screenshot a tab to PNG.
- `open [url]` — open a new tab.

`<target>` is a unique prefix of a tab id from `list` (add characters if it's
ambiguous). Never reuse a tab id from a previous session — always `list` first.

## If it can't connect

`list` failing means Arc isn't up with the debug port. Tell the user to run
`arc-debug-ensure status`; if it reports the port DOWN with Arc running, the
heal agent will restore it within ~30s, or they can re-run this plugin's
`install.sh`.

## Notes

- Screenshots are viewport-only — scroll first with `eval "window.scrollTo(0, N)"`.
- The endpoint is loopback-only and drives the user's real browsing session;
  don't take destructive actions (closing tabs, submitting forms) without asking.
