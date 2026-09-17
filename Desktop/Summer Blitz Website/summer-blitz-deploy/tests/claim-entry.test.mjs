import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../social/app.js', import.meta.url), 'utf8'))
  .replace("import './stk-data.js';", '');

class Node {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.hidden = false;
    this.attributes = new Map();
    this.className = '';
    this.id = '';
    this.textContent = '';
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener() {}
  querySelector(selector) {
    if (selector[0] === '#') return this.find(node => node.id === selector.slice(1));
    if (selector === '.layout') return this.find(node => node.className === 'layout');
    if (selector === '[data-page="profile"]') return this.find(node => node.dataset.page === 'profile');
    return null;
  }
  querySelectorAll(selector) {
    if (selector === '[data-page]') return this.findAll(node => Boolean(node.dataset.page));
    if (selector === 'nav [data-view]') return [];
    return [];
  }
  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) {
      if (child instanceof Node) {
        const match = child.find(predicate);
        if (match) return match;
      }
    }
    return null;
  }
  findAll(predicate, matches = []) {
    if (predicate(this)) matches.push(this);
    for (const child of this.children) if (child instanceof Node) child.findAll(predicate, matches);
    return matches;
  }
}

function startInvite(previewInvite, search = '?t=' + 'a'.repeat(64)) {
  const root = new Node('div');
  const layout = new Node('div'); layout.className = 'layout';
  const feedPage = new Node('section'); feedPage.dataset.page = 'feed';
  const profilePage = new Node('section'); profilePage.dataset.page = 'profile'; profilePage.hidden = true;
  const posts = new Node(); posts.id = 'stk-posts'; feedPage.append(posts);
  const stats = new Node(); stats.id = 'stk-profile-stats'; profilePage.append(stats);
  layout.append(feedPage, profilePage);
  root.append(layout);

  const document = {
    activeElement: null,
    createElement: tag => new Node(tag),
    createTextNode: text => text,
    getElementById(id) {
      if (id === 'stk-social') return root;
      if (id === 'stk-app-data') return { textContent: '{"logo":"/assets/logo-skull-circle.png"}' };
      return null;
    },
  };
  const load = new Promise(() => {});
  const window = {
    STK_INVITE_PREVIEW_TIMEOUT_MS: 5,
    STKData: {
      load: () => load,
      auth: {
        session: async () => null,
        previewInvite,
      },
    },
  };
  const execution = vm.runInNewContext(source, {
    window, document, URLSearchParams, JSON, location: { search },
    setTimeout, clearTimeout, console, Date, Intl, Promise, Number,
  });
  execution.catch(() => {});
  return { feedPage, profilePage, stats };
}

test('signed-out invite renders claim entry before the feed load finishes', async () => {
  const { feedPage, profilePage, stats } = startInvite(async () => ({ state: 'live' }));

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(feedPage.hidden, true);
  assert.equal(profilePage.hidden, false);
  assert.equal(stats.querySelector('#stk-claim-status')?.textContent,
    'Invite confirmed. Enter the player number STK sent you.');
  assert.equal(stats.querySelector('#stk-claim-form')?.hidden, false);
});

test('rejected invite preview replaces checking state with a safe retry message', async () => {
  const { stats } = startInvite(async () => { throw new Error('SECRET'); });
  await new Promise(resolve => setTimeout(resolve, 10));
  const message = stats.querySelector('#stk-claim-status')?.textContent;
  assert.notEqual(message, 'Checking your invite…');
  assert.match(message, /try again/i);
  assert.equal(message.includes('SECRET'), false);
  assert.equal(stats.querySelector('#stk-claim-form')?.hidden, false);
});

test('hanging invite preview never gates the claim form', async () => {
  const { stats } = startInvite(() => new Promise(() => {}));
  await new Promise(resolve => setImmediate(resolve));
  const message = stats.querySelector('#stk-claim-status')?.textContent;
  assert.notEqual(message, 'Checking your invite…');
  assert.match(message, /player number/i);
  assert.equal(stats.querySelector('#stk-claim-form')?.hidden, false);
});

test('resolved dead invite hides the claim form', async () => {
  const { stats } = startInvite(async () => ({ state: 'expired' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(stats.querySelector('#stk-claim-status')?.textContent, /expired/i);
  assert.equal(stats.querySelector('#stk-claim-form')?.hidden, true);
});

test('an invite URL shows and locks its canonical player number immediately', async () => {
  const search = '?t=' + 'a'.repeat(64) + '&n=26091302';
  const { stats } = startInvite(() => new Promise(() => {}), search);
  await new Promise(resolve => setImmediate(resolve));

  assert.ok(stats.find(node => node.textContent === 'Your player number is #26091302'));
  assert.equal(stats.querySelector('#stk-claim-number')?.value, '26091302');
  assert.equal(stats.querySelector('#stk-claim-number')?.readOnly, true);
  assert.equal(stats.querySelector('#stk-claim-form')?.hidden, false);
});

test('old links and invalid player numbers keep the manual number field', async () => {
  const searches = [
    '?t=' + 'a'.repeat(64),
    '?t=' + 'a'.repeat(64) + '&n=01',
    '?t=' + 'a'.repeat(64) + '&n=1.2',
    '?t=' + 'a'.repeat(64) + '&n=-1',
    '?t=' + 'a'.repeat(64) + '&n=9223372036854775808',
  ];
  for (const search of searches) {
    const { stats } = startInvite(() => new Promise(() => {}), search);
    await new Promise(resolve => setImmediate(resolve));
    assert.notEqual(stats.querySelector('#stk-claim-number')?.readOnly, true, search);
    assert.equal(stats.find(node => String(node.textContent).startsWith('Your player number is #')), null, search);
  }
});
