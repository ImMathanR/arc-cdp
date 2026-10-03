# arc-cdp

**Let your coding agent — Claude Code, Codex — drive the [Arc browser](https://arc.net), and keep it working across Arc's auto-updates.**

Coding agents can drive a browser over the Chrome DevTools Protocol; that's how Claude Code's `/chrome-cdp` works. But it attaches to **Chrome**. Make Arc your default browser and there's nothing to attach to. Arc is Chromium and speaks the same protocol, but only when it's launched with `--remote-debugging-port` — and Arc never is. `arc-cdp` fixes that with two tiny launch agents so Arc is always reachable on a debug port, then **self-heals after every Arc update**. Then you point your agent at it: `/arc` in Claude Code, or the endpoint in Codex.

macOS only (it uses `launchd` + Arc).

## Quickstart

```bash
git clone https://github.com/immathanr/arc-cdp.git
cd arc-cdp && ./install.sh
```

That's the whole setup. From now on **Arc always answers the Chrome DevTools Protocol at `http://127.0.0.1:9223`** — across restarts, and across Arc's auto-updates. Check it, then drive it:

```bash
arc-debug-ensure status                        # → debug: UP (port 9223 answering)
curl -s http://127.0.0.1:9223/json/version     # the CDP handshake

node arc-cdp.mjs list                          # list open tabs (id · title · url)
node arc-cdp.mjs eval <id> "document.title"    # run JS in a tab
node arc-cdp.mjs shot <id> shot.png            # screenshot a tab
```

`<id>` is a unique prefix of a tab id from `list`. In Claude Code, just run **`/arc`** — see [Use it with your coding agent](#use-it-with-your-coding-agent).

---

## Why this exists

Point any CDP client at Chrome and it works, because Chrome tooling knows how to launch Chrome with a debug port. Do the same for Arc and you hit two walls:

1. **Arc is never launched with the flag.** When Arc is your default browser it's opened by the OS, by links, by Spotlight — never with `--remote-debugging-port`. So there's no debug endpoint to connect to, and a "connect to Chrome" tool finds nothing (Arc isn't Chrome, and the running Arc has no open port).

2. **Arc updates silently kill the debug port.** Arc auto-updates through Sparkle. An update swaps the app bundle and **relaunches Arc without your flags**. Even if you *had* started Arc with `--remote-debugging-port`, an update that lands mid-session drops it — and your automation just stops connecting, with no obvious reason why.

So a one-off `Arc --remote-debugging-port=9223` isn't enough. You need something that keeps the port alive.

## How it works

Two `launchd` agents and one small script:

- **`com.arc.debug-launch`** — at login, starts Arc with `--remote-debugging-port=9223`.
- **`com.arc.debug-heal`** — every 30 seconds (and at login), runs `arc-debug-ensure`. If Arc is **running but the debug port isn't answering** — exactly the state a Sparkle update leaves you in — it gracefully quits and relaunches Arc *with* the flag. Within ~30s of any Arc upgrade, the debug endpoint is back. **You never have to think about it.**

`arc-debug-ensure` is deliberately conservative:

- If the port is already answering → does nothing (the normal case).
- If Arc isn't running at all → does nothing (so you can quit Arc and have it *stay* quit).
- It waits out an ~8s grace window before acting, so it never kills an Arc that's just mid-launch.

That's the whole trick: the debug port isn't something you turn on once — it's something that's continuously *ensured*, so an Arc upgrade can't take it away.

## Install

```bash
git clone https://github.com/immathanr/arc-cdp.git
cd arc-cdp
./install.sh
```

That installs `arc-debug` and `arc-debug-ensure` to `~/.local/bin`, writes the two LaunchAgents to `~/Library/LaunchAgents` (with your real paths), loads them, and brings Arc up on the debug port.

Verify:

```bash
arc-debug-ensure status
# debug: UP (port 9223 answering)
# arc:   RUNNING
# action: none (healthy)

curl -s http://127.0.0.1:9223/json/version
```

## Use it with your coding agent

- **Claude Code** — `install.sh` drops an `/arc` skill into `~/.claude/skills` (only if Claude Code is present, and it never overwrites an existing one). Just run **`/arc`** and ask it to drive your Arc tabs — the same way `/chrome-cdp` drives Chrome.
- **Codex, or any other agent/tool** — point it at the CDP endpoint **`http://127.0.0.1:9223`**. The bundled client is a working, dependency-free example (Node 22+):

  ```bash
  node arc-cdp.mjs list                          # open tabs (id · title · url)
  node arc-cdp.mjs nav  <id> https://example.com
  node arc-cdp.mjs eval <id> "document.title"
  node arc-cdp.mjs shot <id> shot.png
  node arc-cdp.mjs snap <id>                     # accessibility tree (compact page structure)
  node arc-cdp.mjs open https://example.com --space work   # reuse the tab already showing it in that Arc space
  node arc-cdp.mjs click <id> "button.submit"    # also: clickxy, type, html, net, loadall, evalraw
  ```

  `<id>` is a unique prefix of a tab id from `list`. Page commands go through a small per-tab daemon that keeps the
  CDP session open, so repeated commands are instant; it exits after 20 minutes idle. Run `node arc-cdp.mjs` for the
  full command list.

- **Goal-driven browsing (optional)** — `jev-browse.py "<goal>" --start <url>` lets [Jev](https://typesafe.ai) decide
  each step from the accessibility tree and acts through `agent-browser`; it needs the `jev` Claude Code skill.

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `ARC_CDP_PORT` | `9223` | Debug port. Must match the LaunchAgents — set it before `./install.sh`. |
| `ARC_CDP_HOST` | `127.0.0.1` | Host the client connects to. |
| `ARC_APP` | `/Applications/Arc.app` | Path to Arc, for non-standard installs. |

## Uninstall

```bash
./uninstall.sh
```

Removes the agents and scripts. Arc keeps running with the flag until you quit and reopen it normally.

## Security note

The debug port listens on **loopback only** (`127.0.0.1`), so it isn't exposed to your network. But like Chrome's own remote-debugging port, anything that can already run code as your user can drive your browser through it. That's the same trade-off you accept with any CDP automation — just be aware the port is always up.

## License

MIT © immathanr. `arc-cdp.mjs` is adapted from [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) (MIT © pasky); both notices are in [LICENSE](LICENSE).
