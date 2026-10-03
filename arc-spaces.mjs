// arc-spaces - Arc's own view of spaces and tabs, via AppleScript (JXA).
//
// CDP only sees tabs that are loaded, and knows nothing about spaces. Arc's
// scripting interface sees every tab (including ones not loaded since a
// relaunch) and which space it lives in, and can select tabs, focus spaces
// and create tabs inside a given space. arc-cdp uses this for `open` (reuse an
// already-open page, else open in the requested space) and `tabs`.

import { execFileSync } from 'child_process';

// What the user says -> the Arc space it means.
export const SPACE_ALIASES = { per: 'Personal', personal: 'Personal', work: 'Work' };

/** "per" / "work" / an exact space title (any case) -> the space's real title. */
export function resolveSpace(wanted, titles) {
  if (!wanted) return null;
  const name = SPACE_ALIASES[wanted.toLowerCase()] || wanted;
  const hit = titles.find(t => t.toLowerCase() === name.toLowerCase());
  if (!hit) throw new Error(`No Arc space "${wanted}". Spaces: ${titles.join(', ')}`);
  return hit;
}

/** Adds a scheme when the user gave a bare host (localhost gets http). */
export function withScheme(url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(url) ? 'http://' : 'https://') + url;
}

/** Same page? Ignores http/https, default ports, a trailing slash, and #fragment. */
export function samePageKey(url) {
  try {
    const u = new URL(withScheme(url));
    if (!/^https?:$/.test(u.protocol)) return url;
    const port = u.port && !['80', '443'].includes(u.port) ? `:${u.port}` : '';
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.hostname.toLowerCase()}${port}${path}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * Which existing tab to reuse. Only a tab in the requested space counts (spaces
 * can be signed in to different accounts); matches elsewhere are reported.
 * With no space requested, any space counts, the active space first.
 */
export function pickExisting(tabs, url, space, activeSpace) {
  const key = samePageKey(url);
  const matches = tabs.filter(t => samePageKey(t.url) === key);
  const order = t => (t.space === (space || activeSpace) ? 0 : 1);
  const usable = space ? matches.filter(t => t.space === space) : [...matches].sort((a, b) => order(a) - order(b));
  const elsewhere = space ? matches.filter(t => t.space !== space) : [];
  return { tab: usable[0] || null, elsewhere };
}

// ── AppleScript plumbing ────────────────────────────────────────────────────
function jxa(script) {
  return execFileSync('osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8' }).trim();
}

/** Every tab in the front window: {space, id, url, title}, plus the active space. */
export function arcTabs() {
  const out = jxa(`
    const w = Application('Arc').windows[0];
    const clean = s => String(s || '').replace(/[\\t\\n]/g, ' ');
    const rows = ['ACTIVE\\t' + clean(w.activeSpace.title())];
    const titles = w.spaces.title();  // index access: iterating w.spaces() trips a type error
    for (let k = 0; k < titles.length; k++) {
      const s = w.spaces[k];
      const title = clean(titles[k]), ids = s.tabs.id(), urls = s.tabs.url(), names = s.tabs.title();
      for (let i = 0; i < ids.length; i++) rows.push([title, ids[i], clean(urls[i]), clean(names[i])].join('\\t'));
    }
    rows.join('\\n');`);
  const [head, ...rows] = out.split('\n');
  const tabs = rows.filter(Boolean).map(r => {
    const [space, id, url, title] = r.split('\t');
    return { space, id, url, title };
  });
  return { active: head.split('\t')[1], tabs, spaces: [...new Set(tabs.map(t => t.space))] };
}

export function arcSpaceTitles() {
  return jxa(`Application('Arc').windows[0].spaces.title().join('\\n')`).split('\n').filter(Boolean);
}

/** Focus the tab's space and select the tab. */
export function selectTab(space, tabId) {
  jxa(`
    const w = Application('Arc').windows[0];
    const s = w.spaces[w.spaces.title().indexOf(${JSON.stringify(space)})];
    s.focus();
    s.tabs.byId(${JSON.stringify(tabId)}).select();
    'ok';`);
}

/** New tab in the given space (focused), returns the Arc tab id. */
export function openInSpace(space, url) {
  const q = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  return execFileSync('osascript', ['-e', `
    tell application "Arc"
      tell front window
        tell space ${q(space)}
          focus
          make new tab with properties {URL:${q(url)}}
        end tell
        -- the new tab's own reference can't be read back; it is now the active tab
        return id of active tab
      end tell
    end tell`], { encoding: 'utf8' }).trim();
}

/** The tab's current URL as Arc reports it (after redirects). */
export function tabUrl(tabId) {
  return jxa(`
    const w = Application('Arc').windows[0];
    let url = '';
    const n = w.spaces.title().length;
    for (let k = 0; k < n && !url; k++) { try { url = w.spaces[k].tabs.byId(${JSON.stringify(tabId)}).url(); } catch (e) {} }
    url;`);
}
