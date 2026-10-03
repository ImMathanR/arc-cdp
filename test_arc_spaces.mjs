// Checks for arc-spaces.mjs. Run: node test_arc_spaces.mjs
import assert from 'node:assert/strict';
import { resolveSpace, withScheme, samePageKey, pickExisting } from './arc-spaces.mjs';

const SPACES = ['Personal', 'Work', 'levi'];
const TABS = [
  { space: 'Personal', id: 'p1', url: 'https://github.com/immathanr/zap/', title: 'zap' },
  { space: 'Work', id: 'w1', url: 'http://127.0.0.1:8790/#top', title: 'zap local' },
  { space: 'Work', id: 'w2', url: 'https://docs.example.com/wiki/abc?from=x', title: 'wiki' },
];
const tests = {
  'per and work map to Personal and Work': () => {
    assert.equal(resolveSpace('per', SPACES), 'Personal');
    assert.equal(resolveSpace('WORK', SPACES), 'Work');
    assert.equal(resolveSpace('levi', SPACES), 'levi');
    assert.equal(resolveSpace(undefined, SPACES), null);
    assert.throws(() => resolveSpace('home', SPACES), /No Arc space "home"/);
  },
  'bare hosts get a scheme, localhost gets http': () => {
    assert.equal(withScheme('127.0.0.1:8790'), 'http://127.0.0.1:8790');
    assert.equal(withScheme('github.com/x'), 'https://github.com/x');
    assert.equal(withScheme('about:blank'), 'about:blank');
  },
  'same page ignores scheme, trailing slash and fragment but not query': () => {
    assert.equal(samePageKey('http://github.com/immathanr/zap'), samePageKey('https://github.com/immathanr/zap/#readme'));
    assert.notEqual(samePageKey('https://x.com/a?p=1'), samePageKey('https://x.com/a?p=2'));
  },
  'reuses the tab in the requested space': () => {
    const { tab, elsewhere } = pickExisting(TABS, '127.0.0.1:8790', 'Work', 'Personal');
    assert.equal(tab.id, 'w1');
    assert.deepEqual(elsewhere, []);
  },
  'does not reuse a tab from the other space, but reports it': () => {
    const { tab, elsewhere } = pickExisting(TABS, 'github.com/immathanr/zap', 'Work', 'Work');
    assert.equal(tab, null);
    assert.equal(elsewhere[0].space, 'Personal');
  },
  'without a space, any space counts, the active one first': () => {
    const both = [...TABS, { space: 'Work', id: 'w3', url: 'https://github.com/immathanr/zap', title: 'zap' }];
    assert.equal(pickExisting(both, 'github.com/immathanr/zap', null, 'Work').tab.id, 'w3');
    assert.equal(pickExisting(both, 'github.com/immathanr/zap', null, 'levi').tab.id, 'p1');
  },
};
let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('pass', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); }
}
process.exit(failed);
