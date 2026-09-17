import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const landing = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const html = await readFile(new URL('../social/index.html', import.meta.url), 'utf8');
const killShot = await readFile(new URL('../kill-shot.html', import.meta.url), 'utf8');
const hosting = JSON.parse(await readFile(new URL('../firebase.json', import.meta.url), 'utf8'));

function runKillShot(search) {
  const head = killShot.match(/<head>([\s\S]*?)<\/head>/i)?.[1] || '';
  const firstScript = head.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || '';
  const redirects = [];
  vm.runInNewContext(firstScript, {
    URLSearchParams,
    window: { location: { search, replace: value => redirects.push(value) } },
  });
  return redirects;
}

test('interactive element ids are unique', () => {
  const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g), match => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(duplicates, []);
});

test('prototype-only social concept label is absent', () => {
  assert.equal(html.includes('SOCIAL CONCEPT'), false);
});

test('account control uses the circular logo asset', () => {
  assert.match(html, /class="account-logo" src="\/assets\/logo-skull-circle\.png"/);
});

test('feedback copy reflects the live submission behavior', () => {
  assert.equal(html.includes('Preview form'), false);
  assert.equal(html.includes('Nothing is sent to the league yet.'), false);
  assert.equal(html.includes('Feedback captured in this preview.'), false);
  assert.equal(html.includes('It hasn’t been sent to the league.'), false);
  assert.match(html, /Feedback is sent to the STK league team\./);
  assert.match(html, /<h3>Feedback sent\.<\/h3>/);
  assert.match(html, /Thanks — the league has received it\./);
});

test('hosting excludes nested repository metadata and debug logs', () => {
  assert.ok(hosting.hosting.ignore.includes('**/.*'));
  assert.ok(hosting.hosting.ignore.includes('.git/**'));
  assert.ok(hosting.hosting.ignore.includes('.vscode/**'));
  assert.ok(hosting.hosting.ignore.includes('**/firebase-debug.log'));
});

test('landing, social shell, and social scripts are never served stale', () => {
  const noCache = new Map(hosting.hosting.headers.map(rule => [
    rule.source,
    Object.fromEntries(rule.headers.map(header => [header.key, header.value])),
  ]));
  for (const source of ['/', '/index.html', '/kill-shot.html', '/social', '/social/**']) {
    assert.equal(noCache.get(source)?.['Cache-Control'], 'no-store, no-cache, must-revalidate');
  }
});

test('Kill Shot immediately forwards an exact invite token to social', () => {
  const token = 'A1'.repeat(32);
  assert.deepEqual(runKillShot('?t=' + token), ['/social/?t=' + token.toLowerCase()]);
});

test('Kill Shot remains visible without one exact 64-hex invite token', () => {
  for (const search of [
    '',
    '?source=home',
    '?T=' + 'a'.repeat(64),
    '?t=' + 'a'.repeat(63),
    '?t=' + 'a'.repeat(65),
    '?t=' + 'g'.repeat(64),
  ]) assert.deepEqual(runKillShot(search), []);
});

test('root redirects to Kill Shot and social stays under /social', () => {
  assert.match(landing, /Play Killer Pool — STK Pool League/);
  assert.equal(landing.includes('id="stk-social"'), false);
  assert.match(html, /id="stk-social"/);
  assert.deepEqual(hosting.hosting.redirects, [{
    source: '/',
    destination: '/kill-shot.html',
    type: 302,
  }]);
});
