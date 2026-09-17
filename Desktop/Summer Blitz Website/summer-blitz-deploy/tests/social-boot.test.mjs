import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../social/index.html', import.meta.url), 'utf8');
const source = (await readFile(new URL('../social/app.js', import.meta.url), 'utf8'))
  .replace("import './stk-data.js';", '');
const token = 'a'.repeat(64);

class FakeNode {
  constructor(tag = 'div', ownerDocument = null) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.className = '';
    this.id = '';
    this.hidden = false;
    this.value = '';
    this.open = false;
    this._text = '';
    this._listeners = new Map();
  }
  get textContent() { return this._text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(value) { this._text = String(value ?? ''); this.children = []; }
  get classList() {
    return { contains: name => this.className.split(/\s+/).includes(name) };
  }
  append(...children) {
    for (const child of children) {
      if (child instanceof FakeNode) child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  setAttribute(name, value) {
    const clean = String(value);
    this.attributes.set(name, clean);
    if (name === 'id') this.id = clean;
    if (name === 'class') this.className = clean;
    if (name === 'hidden') this.hidden = true;
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = clean;
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  addEventListener(type, fn) {
    const listeners = this._listeners.get(type) || [];
    listeners.push(fn); this._listeners.set(type, listeners);
  }
  async dispatch(type, target = this) {
    const event = { target, preventDefault() {} };
    for (const fn of this._listeners.get(type) || []) await fn(event);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const matches = [];
    for (const candidate of this.descendants()) {
      if (selector.split(',').some(part => matchesSelectorChain(candidate, part.trim()))) matches.push(candidate);
    }
    return matches;
  }
  *descendants() {
    for (const child of this.children) {
      if (!(child instanceof FakeNode)) continue;
      yield child;
      yield* child.descendants();
    }
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (selector.split(',').some(part => matchesSimple(node, part.trim()))) return node;
    }
    return null;
  }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  setCustomValidity() {}
  reportValidity() { return true; }
  reset() {
    for (const node of this.descendants()) if ('value' in node) node.value = '';
  }
}

function matchesSelectorChain(node, selector) {
  const parts = selector.split(/\s+/).filter(Boolean);
  if (!matchesSimple(node, parts.pop())) return false;
  let ancestor = node.parentElement;
  while (parts.length) {
    const wanted = parts.pop();
    while (ancestor && !matchesSimple(ancestor, wanted)) ancestor = ancestor.parentElement;
    if (!ancestor) return false;
    ancestor = ancestor.parentElement;
  }
  return true;
}

function matchesSimple(node, selector) {
  const attrs = [...selector.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
  const core = selector.replace(/\[[^\]]+\]/g, '');
  const id = core.match(/#([\w-]+)/)?.[1];
  const classes = [...core.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
  const tag = core.match(/^[a-z][\w-]*/i)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  if (id && node.id !== id) return false;
  const nodeClasses = new Set(node.className.split(/\s+/).filter(Boolean));
  if (classes.some(name => !nodeClasses.has(name))) return false;
  return attrs.every(([, name, expected]) => {
    const actual = name.startsWith('data-')
      ? node.dataset[name.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())]
      : node.getAttribute(name) ?? node[name];
    return expected === undefined ? actual !== undefined && actual !== null && actual !== false : String(actual) === expected;
  });
}

function parseDocument(markup) {
  const document = {
    activeElement: null,
    documentElement: null,
    createElement: tag => new FakeNode(tag, document),
    createTextNode: text => String(text),
    getElementById(id) { return this.documentElement.closest('#' + id) || this.documentElement.querySelector('#' + id); },
  };
  const root = new FakeNode('document', document);
  document.documentElement = root;
  const stack = [root];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'path', 'circle', 'line']);
  for (const tokenPart of markup.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g)) {
    const part = tokenPart[0];
    if (part.startsWith('<!--') || part.startsWith('<!')) continue;
    if (part.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (part.startsWith('<')) {
      const name = part.match(/^<\s*([\w-]+)/)?.[1];
      if (!name) continue;
      const node = new FakeNode(name, document);
      for (const match of part.matchAll(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        const attr = match[1];
        if (attr.toLowerCase() === name.toLowerCase()) continue;
        node.setAttribute(attr, match[2] ?? match[3] ?? match[4] ?? '');
      }
      stack.at(-1).append(node);
      if (!voidTags.has(name.toLowerCase()) && !part.endsWith('/>')) stack.push(node);
    } else {
      stack.at(-1)._text += part;
    }
  }
  return document;
}

function player() {
  return { id: 'player-1', full_name: 'Someone', player_number: '26091302' };
}

async function boot({ search = '?t=' + token, initialSession = null, initialPlayer = null, attendance = [], calendar = [] } = {}) {
  const document = parseDocument(html);
  const root = document.getElementById('stk-social');
  let currentSession = initialSession;
  let currentPlayer = initialPlayer;
  let authChange;
  const claims = [];
  const location = { search, pathname: '/social/', href: '/social/' + search };
  const payload = () => ({
    me: currentPlayer,
    is_admin: false,
    attendance,
    calendar,
    winners: [],
    seed_reference_time: '2026-09-17T12:00:00Z',
    seedCandidatesByVenue: {},
    feed: [],
    feedPayload: [],
    profile: currentPlayer ? { is_demo: false, matches: [], credits: [] } : null,
    errors: [],
  });
  const auth = {
    session: async () => currentSession,
    previewInvite: async () => ({ state: 'live' }),
    onChange(fn) { authChange = fn; },
    async signOut() { currentSession = null; currentPlayer = null; return { error: null }; },
    async signIn() { return { error: null }; },
    async claim(input) { claims.push(input); return { player_id: 'claimed-player' }; },
  };
  const window = {
    STK_INVITE_PREVIEW_TIMEOUT_MS: 20,
    STKData: {
      load: async () => payload(),
      initials: name => String(name || '').split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase(),
      auth,
      writes: {
        rsvp: async () => ({ error: null }), like: async () => ({ error: null }),
        comment: async () => ({ error: null }), feedback: async () => ({ error: null }),
        removePost: async () => ({ error: null }), removeComment: async () => ({ error: null }),
        createPost: async () => ({ error: null }),
      },
    },
    STKBounty: { board: () => ({ mode: 'attendance', game: null, players: [] }) },
    lucide: { createIcons() {} },
  };
  await vm.runInNewContext(source, {
    window, document, location, URLSearchParams, JSON, Date, Intl, Promise, Number,
    setTimeout, clearTimeout, console, FileReader: class {}, Array, Object, String,
  });
  return { document, root, location, claims, authChange: session => authChange(session) };
}

test('full real social shell boots a linked session invite without a crash or split identity', async () => {
  const session = { user: { email: 'someone@example.com' } };
  const game = { id: 'game-1', venue_name: 'The Globe Tavern', starts_at: '2026-09-20T01:00:00Z' };
  const app = await boot({
    initialSession: session,
    initialPlayer: player(),
    attendance: [{ player_id: 'player-1', game_id: 'game-1', status: 'confirmed' }],
    calendar: [game],
  });

  assert.equal(app.document.getElementById('stk-my-matches'), null);
  assert.equal(app.root.querySelector('[data-page="profile"]').hidden, false);
  assert.equal(app.root.querySelector('[data-page="feed"]').hidden, true);
  assert.match(app.document.getElementById('stk-account-button').textContent, /Profile/);
  assert.doesNotMatch(app.document.getElementById('stk-account-button').textContent, /Sign in/);
  assert.match(app.document.getElementById('stk-profile-stats').textContent, /signed in as Someone \(someone@example\.com\)/i);
  assert.match(app.document.getElementById('stk-claim-status').textContent, /not been claimed/i);
  assert.doesNotMatch(app.document.getElementById('stk-profile-stats').textContent, /Your game, by the numbers/);
  assert.equal(app.document.getElementById('stk-claim-form'), null);
  assert.equal(app.root.querySelector('[data-rsvp="0"]').textContent, '✓ Going · Cancel RSVP');
});

test('switching a linked account signs out while preserving the invite claim view and token', async () => {
  const app = await boot({ initialSession: { user: { email: 'someone@example.com' } }, initialPlayer: player() });
  await app.root.dispatch('click', app.document.getElementById('stk-signout'));

  assert.equal(app.location.search, '?t=' + token);
  assert.equal(app.root.querySelector('[data-page="profile"]').hidden, false);
  assert.ok(app.document.getElementById('stk-claim-form'));
  assert.ok(app.document.getElementById('stk-claim-email'));
  assert.ok(app.document.getElementById('stk-claim-password'));
});

test('signed-out invite shows the complete account claim form', async () => {
  const app = await boot();
  assert.ok(app.document.getElementById('stk-claim-form'));
  for (const id of ['stk-claim-number', 'stk-claim-name', 'stk-claim-phone', 'stk-claim-email', 'stk-claim-password']) {
    assert.ok(app.document.getElementById(id), id);
  }
});

test('unlinked authenticated session claims with its displayed email', async () => {
  const email = 'ready@example.com';
  const app = await boot({ initialSession: { user: { email } } });
  const form = app.document.getElementById('stk-claim-form');
  assert.match(form.textContent, new RegExp(email));
  assert.equal(app.document.getElementById('stk-claim-email'), null);
  assert.equal(app.document.getElementById('stk-claim-password'), null);
  app.document.getElementById('stk-claim-number').value = '26091302';
  app.document.getElementById('stk-claim-name').value = 'New Player';
  app.document.getElementById('stk-claim-phone').value = '555-0100';
  await app.root.dispatch('submit', form);
  assert.equal(app.claims.length, 1);
  assert.equal(app.claims[0].email, email);
  assert.equal(app.claims[0].password, '');
});

test('normal signed-in profile and RSVP rendering still work without an invite', async () => {
  const game = { id: 'game-1', venue_name: 'The Globe Tavern', starts_at: '2026-09-20T01:00:00Z' };
  const app = await boot({
    search: '', initialSession: { user: { email: 'someone@example.com' } }, initialPlayer: player(),
    attendance: [{ player_id: 'player-1', game_id: 'game-1', status: 'checked_in' }], calendar: [game],
  });
  assert.equal(app.root.querySelector('[data-page="feed"]').hidden, false);
  assert.match(app.document.getElementById('stk-account-button').textContent, /Profile/);
  assert.match(app.document.getElementById('stk-profile-stats').textContent, /Someone/);
  assert.match(app.document.getElementById('stk-profile-stats').textContent, /Your game, by the numbers/);
  assert.equal(app.root.querySelector('[data-rsvp="0"]').textContent, '✓ Going · Cancel RSVP');
});

test('auth changes update the header identity immediately', async () => {
  const app = await boot({ search: '' });
  assert.match(app.document.getElementById('stk-account-button').textContent, /Sign in/);
  app.authChange({ user: { email: 'live@example.com' } });
  assert.match(app.document.getElementById('stk-account-button').textContent, /Claim account/);
  assert.doesNotMatch(app.document.getElementById('stk-account-button').textContent, /Sign in/);
});
