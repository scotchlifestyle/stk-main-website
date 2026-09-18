import './stk-data.js';

(async () => {
  'use strict';
  const root = document.getElementById('stk-social');
  const assets = JSON.parse(document.getElementById('stk-app-data').textContent);
  const $ = selector => root.querySelector(selector);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const icons = () => window.lucide?.createIcons({ attrs: { width: 18, height: 18 } });
  const feed = $('#stk-posts');
  const statsMount = $('#stk-profile-stats');
  // Read the private invite before loading the public feed. Feed hydration makes
  // several network requests and must never leave a claimant on the default
  // feed screen while those requests are slow or unavailable.
  const inviteToken = (new URLSearchParams(location.search).get('t') || '').trim().toLowerCase() || null;
  const maxPlayerNumber = '9223372036854775807';
  function readInvitePlayerNumber(search) {
    const raw = (new URLSearchParams(search).get('n') || '').trim();
    if (!/^[1-9][0-9]*$/.test(raw)) return null;
    if (raw.length > maxPlayerNumber.length) return null;
    if (raw.length === maxPlayerNumber.length && raw > maxPlayerNumber) return null;
    return raw;
  }
  const invitePlayerNumber = readInvitePlayerNumber(location.search);
  const invitePreviewTimeout = Number.isFinite(window.STK_INVITE_PREVIEW_TIMEOUT_MS)
    ? window.STK_INVITE_PREVIEW_TIMEOUT_MS : 8000;

  // Detect /social/post/<id> — used for share-link deep links.
  const linkedPostId = (function () {
    var m = location.pathname.match(/\/social\/post\/([^\/]+)/);
    return m ? m[1] : null;
  }());

  const BOUNTY_LABEL = 'Bounty: previous winner. Eliminate this player while still active to earn an extra life.';
  // A card still read straight from the scoring tables has no social_posts row
  // behind it, so likes, comments and removal have nothing to write to. Say so
  // rather than pretend the action took.
  const DERIVED_NOTE = 'This card is read live from the match results and is not stored on the feed yet. An admin sign-in publishes it.';
  const isDerived = id => String(id || '').indexOf('derived:') === 0;
  // Storage URLs pointed at Supabase's transform endpoint deliver a decoded-
  // size much closer to what the phone actually renders. 1280 covers a 3x DPR
  // phone; anything larger only costs decode memory.
  function feedPhotoUrl(raw) {
    if (!raw || typeof raw !== 'string') return raw;
    const marker = '/storage/v1/object/public/';
    if (raw.indexOf(marker) === -1) return raw;
    const transformed = raw.replace(marker, '/storage/v1/render/image/public/');
    return transformed + (transformed.indexOf('?') === -1 ? '?' : '&') + 'width=1280&quality=80';
  }
  function bountyBadge(label) {
    const badge = el('span', 'bounty');
    badge.setAttribute('aria-label', label || BOUNTY_LABEL);
    const icon = el('i');
    icon.dataset.lucide = 'crosshair';
    icon.setAttribute('aria-hidden', 'true');
    badge.append(icon, document.createTextNode('Bounty'));
    return badge;
  }

  let me = null;
  let session = await window.STKData.auth.session();
  let claimBusy = false;
  // Reflect the authenticated session immediately. Feed/profile hydration is
  // independent work and must not leave a signed-in person labeled "Sign in".
  applyIdentity();
  if (inviteToken) {
    renderStats(null);
    navigate('profile');
    await initializeInvite();
  }
  let data = await window.STKData.load();
  me = data.me;
  applyIdentity();
  window.STKData.auth.onChange(nextSession => {
    session = nextSession;
    applyIdentity();
    setTimeout(() => {
      if (!claimBusy) refreshFeed().catch(() => {
        $('#stk-status').textContent = 'Could not refresh your account. Please reload.';
      });
    }, 0);
  });
  // Answered by the database's own is_admin() predicate, not by anything the
  // page decides. The control it shows is a convenience; RLS is the boundary.
  let isAdmin = data.is_admin === true;
  let attendance = data.attendance, games = data.calendar, results = data.winners;
  let now = data.seed_reference_time;
  let seedCandidatesByVenue = data.seedCandidatesByVenue;
  let attachments = [], attachedFiles = [], preparing = false;
  const feedbackDrafts = [];

  function navigate(page) {
    if (page === 'profile' && !me && !inviteToken && !session) { openSignIn(); return; }
    if (!$('[data-page="' + page + '"]')) return;
    root.querySelectorAll('[data-page]').forEach(p => p.hidden = p.dataset.page !== page);
    root.querySelectorAll('nav [data-view]').forEach(b => {
      if (b.dataset.view === page) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    $('.layout').scrollTop = 0;
  }

  const getBoard = () => window.STKBounty.board({
    games, results, attendance, now, seriesId: games.length ? games[0].series_id : null,
    hostIds: me ? [me.id] : [], seedCandidatesByVenue
  });
  function renderBoard() {
    const state = getBoard(), board = $('#stk-bounty-board');
    board.replaceChildren();
    const note = board.closest('section').querySelector('p.muted');
    note.textContent = state.mode === 'seeded'
      ? 'Seeded players · Provisional Globe selection. Confirmed attendance replaces this list.'
      : 'All previous winners qualify. This board shows only confirmed attendees for the next game.';
    if (!state.game) { board.append(el('p', 'empty', 'No upcoming game scheduled.')); return; }
    board.append(el('h3', '', state.game.venue_name), el('p', 'muted',
      new Date(state.game.starts_at).toLocaleString('en-US', {
        timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit'
      })));
    if (!state.players.length) board.append(el('p', 'empty', 'No bounty players confirmed for this game yet.'));
    for (const p of state.players) {
      const row = el('div', 'venue row'), name = el('div', 'name');
      row.append(el('span', 'avatar', p.name.split(' ').map(n => n[0]).join('')));
      name.append(el('h3', '', p.name));
      name.append(bountyBadge());
      if (state.mode === 'seeded') name.append(el('span', 'muted', 'Seed'));
      row.append(name); board.append(row);
    }
    icons();
  }
  function updateRsvps() {
    const mine = me ? attendance.filter(a => a.player_id === me.id && ['confirmed', 'checked_in'].includes(a.status)) : [];
    const box = $('#stk-my-matches');
    if (box) {
      box.replaceChildren();
      if (!mine.length) box.textContent = 'No RSVPs yet. Find your next match.';
      for (const a of mine) {
        const game = games.find(g => g.id === a.game_id);
        if (game) box.append(el('p', '', game.venue_name + ' · ' + new Date(game.starts_at).toLocaleString('en-US', {
          timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
        })));
      }
    }
    root.querySelectorAll('[data-rsvp]').forEach(b => {
      const game = games[Number(b.dataset.rsvp)];
      if (!game) return;
      const going = mine.some(a => a.game_id === game.id);
      b.setAttribute('aria-pressed', String(going));
      b.textContent = going ? '✓ Going · Cancel RSVP' : 'RSVP to match';
    });
  }

  function renderAttachments() {
    $('#stk-attachments').replaceChildren();
    attachments.forEach((src, i) => { const img = el('img'); img.src = src; img.alt = 'Attached photo ' + (i + 1); $('#stk-attachments').append(img); });
    $('#stk-clear-photos').hidden = !attachments.length;
    $('#stk-compose-status').textContent = attachments.length ? attachments.length + ' photo(s) ready. STK watermark will appear in the feed.' : '';
  }
  $('#stk-photo-input').addEventListener('change', async e => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    if (preparing) return;
    if (files.length + attachments.length > 4 || files.some(f => !['image/jpeg', 'image/png', 'image/webp'].includes(f.type) || f.size > 8 * 1024 * 1024)) {
      $('#stk-compose-status').textContent = 'Choose up to 4 JPG, PNG or WebP photos, each under 8 MB.'; e.target.value = ''; return;
    }
    preparing = true;
    $('#stk-compose-status').textContent = 'Preparing photos…';
    try {
      const photos = await Promise.all(files.map(f => new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(f);
      })));
      attachments.push(...photos); attachedFiles.push(...files); renderAttachments();
    } catch { $('#stk-compose-status').textContent = 'Could not read the photo. Please try again.'; }
    finally { preparing = false; e.target.value = ''; }
  });

  // ---- feed rendering: same DOM the static markup produced, from live rows ----
  function renderCard(mount, card, media) {
    if (!card) return;
    if (card.type === 'reward') {
      const hero = el('div', 'reward-hero');
      hero.append(el('div', 'eyebrow', card.eyebrow), el('h2', '', card.headline),
        el('div', 'big-life', card.big), el('p', 'muted', card.note));
      mount.append(hero);
    } else if (card.type === 'winner_poster') {
      const poster = el('div', 'poster winner-poster' + (card.alt ? ' alt' : ''));
      poster.append(el('div', 'eyebrow', card.eyebrow));
      const title = el('div', 'poster-title');
      (card.title_lines || []).forEach((line, i) => {
        if (i) title.append(el('br'));
        title.append(document.createTextNode(line));
      });
      poster.append(title);
      const bottom = el('div', 'poster-bottom'), left = el('div'), name = el('div', 'name');
      name.append(el('h2', '', card.name));
      if (card.bounty) name.append(bountyBadge());
      left.append(name, el('p', 'muted', card.note));
      bottom.append(left, el('span', 'winner-medal', card.medal || 'W'));
      poster.append(bottom);
      mount.append(poster);
    } else if (card.type === 'winner_poster_simple') {
      const poster = el('div', 'poster winner-poster' + (card.alt ? ' alt' : ''));
      poster.append(el('div', 'eyebrow', card.eyebrow), el('h2', '', card.headline), el('p', 'muted', card.note));
      mount.append(poster);
    } else if (card.type === 'photo') {
      // Stacking every photo pushes the actions row a full screen below the
      // fold. A horizontal carousel keeps one album to one card the way
      // Instagram does, with heart/comment/share reachable without scrolling.
      const track = el('div', 'photo-carousel');
      track.setAttribute('role', 'region');
      track.setAttribute('aria-label', 'Photo album, swipe to see more');
      for (const m of media) {
        const wrap = el('div', 'photo-wrap');
        const image = el('img');
        // A raw match-media JPEG can be 3000x4000 / 5+MB, which is above the
        // decoded-image budget mobile Safari will spend before falling back
        // to a black tile. Route through Supabase's image transform so the
        // client only decodes a phone-sized copy.
        image.src = feedPhotoUrl(m.url);
        image.alt = m.alt || '';
        image.loading = 'lazy';
        image.decoding = 'async';
        wrap.append(image);
        if (!m.watermarked) {
          const mark = el('img', 'watermark');
          mark.src = assets.logo; mark.alt = 'STK watermark';
          wrap.append(mark);
        }
        track.append(wrap);
      }
      mount.append(track);
      if (media.length > 1) {
        const count = el('p', 'photo-count', '1 / ' + media.length);
        count.setAttribute('aria-live', 'polite');
        track.addEventListener('scroll', () => {
          const idx = Math.round(track.scrollLeft / track.clientWidth) + 1;
          count.textContent = idx + ' / ' + media.length;
        }, { passive: true });
        mount.append(count);
      }
      if (card.label) mount.append(el('p', 'photo-label', card.label));
    }
  }

  function renderPost(post) {
    const node = document.getElementById('stk-post-template').content.firstElementChild.cloneNode(true);
    if (post.card && post.card.frame) node.classList.add(post.card.frame);
    node.dataset.postId = post.id;
    node.querySelector('.avatar').textContent = post.author_initials;
    node.querySelector('.name h3').textContent = post.author_name;
    if (post.author_is_bounty) node.querySelector('.name').append(bountyBadge());
    node.querySelector('.post-meta').textContent = post.meta_label;
    node.querySelector('.post-copy').textContent = post.body;
    renderCard(node.querySelector('.post-media'), post.card, post.media);

    const likeBtn = node.querySelector('[data-like]');
    const mine = me && post.likes.includes(me.id);
    likeBtn.setAttribute('aria-pressed', String(!!mine));
    likeBtn.querySelector('span').textContent = String(post.likes.length);

    if (isAdmin) {
      const remove = el('button', '', 'Delete');
      remove.type = 'button';
      remove.dataset.delete = '';
      node.querySelector('.actions').append(remove);
    }

    const comments = node.querySelector('.comments'), form = comments.querySelector('.comment-form');
    for (const c of post.comments) {
      const line = el('p', '', c.author_name + ' · ' + c.body);
      if (isAdmin && c.id) {
        const remove = el('button', '', 'Delete');
        remove.type = 'button';
        remove.dataset.deleteComment = c.id;
        line.append(remove);
      }
      form.before(line);
    }
    return node;
  }

  function renderFeed(posts) {
    feed.replaceChildren();
    for (const post of posts) feed.append(renderPost(post));
    icons();
    if (linkedPostId) scrollToLinkedPost(linkedPostId);
  }

  // Scroll the linked post into view and give it a brief highlight.
  // If the id is not found (deleted or bad link) we degrade silently
  // — the feed stays visible and no error is shown.
  function scrollToLinkedPost(postId) {
    var target = feed.querySelector('[data-post-id="' + postId + '"]');
    if (!target) return; // not found: show normal feed, no error
    target.classList.add('post-highlighted');
    target.scrollIntoView({ block: 'center' });
    // Remove the highlight after 2.5 s so it reads as "landed here" not "error"
    setTimeout(function () { target.classList.remove('post-highlighted'); }, 2500);
  }

  // ---- account panel: signed-out sign-in, invite claim, signed-in identity ----
  const dialog = $('#stk-auth-dialog');
  let authOpener = null;
  function openSignIn() {
    authOpener = document.activeElement;
    if (!dialog.open) dialog.showModal();
    $('#stk-signin-email').focus();
  }
  dialog.addEventListener('close', () => {
    $('#stk-signin-password').value = '';
    if (authOpener && authOpener.isConnected) authOpener.focus();
  });
  function applyIdentity() {
    root.querySelectorAll('nav [data-view="profile"]').forEach(button => button.hidden = !me && !inviteToken);
    const button = $('#stk-account-button');
    if (button) {
      button.replaceChildren();
      if (session) {
        button.append(el('span', 'avatar', window.STKData.initials(me ? me.full_name : session.user.email || 'Account')));
        button.append(el('span', '', me ? 'Sign out' : 'Claim account'));
        button.setAttribute('aria-label', me ? 'Sign out' : 'Claim your account');
        button.removeAttribute('aria-haspopup');
      } else {
        const logo = el('img', 'account-logo'); logo.src = assets.logo; logo.alt = '';
        button.append(logo, el('span', '', 'Sign in'));
        button.setAttribute('aria-label', 'Sign in'); button.setAttribute('aria-haspopup', 'dialog');
      }
    }
    const compose = $('#stk-compose');
    if (compose) {
      compose.hidden = !session || !me;
      // The compose card is a prompt, not an identity claim. It reads "STK"
      // and "Write a post" so members are invited to speak, not shown their
      // own name back at them. The published post still carries the member's
      // author info, which the render path sets from `me`.
      compose.querySelector('.avatar').textContent = 'STK';
      compose.querySelector('.name h3').textContent = 'Write a post';
    }
  }

  function accountPanel() {
    const panel = el('section', 'panel');
    if (inviteToken) {
      panel.append(el('div', 'eyebrow', 'Claim your account'), el('h2', '', 'Welcome to STK'));
      const status = el('p', 'muted', me && session
        ? 'This invite has not been claimed.'
        : 'Enter the player number STK sent you.');
      status.id = 'stk-claim-status';
      panel.append(status);
      if (invitePlayerNumber) {
        panel.append(el('p', '', 'Your player number is #' + invitePlayerNumber));
      }
      if (me && session) {
        panel.append(el('p', '', 'You are signed in as ' + me.full_name + ' (' + (session.user.email || 'email unavailable') + ').'));
        panel.append(el('p', 'muted', 'Use a different account to claim this invite.'));
        const out = el('button', '', 'Use a different account');
        out.id = 'stk-signout'; out.type = 'button'; panel.append(out);
        return panel;
      }
      const form = el('form', 'feedback-form');
      form.id = 'stk-claim-form';
      form.hidden = false;
      const fields = [
        ['stk-claim-number', 'Player number', 'text', 'off'],
        ['stk-claim-name', 'Full name', 'text', 'name'],
        ['stk-claim-phone', 'Phone', 'tel', 'tel'],
      ];
      if (!session) fields.push(
        ['stk-claim-email', 'Email', 'email', 'email'],
        ['stk-claim-password', 'Choose a password', 'password', 'new-password'],
      );
      for (const [id, label, type, auto] of fields) {
        const wrap = el('label', '', label);
        const input = el('input');
        input.id = id; input.type = type; input.required = true; input.autocomplete = auto;
        if (type === 'password') input.minLength = 8;
        if (id === 'stk-claim-number') {
          input.inputMode = 'numeric'; input.pattern = '[0-9]+';
          if (invitePlayerNumber) { input.value = invitePlayerNumber; input.readOnly = true; }
        }
        wrap.append(input);
        form.append(wrap);
      }
      if (session) {
        form.append(el('p', 'muted', 'This invite will be claimed for ' + session.user.email + '.'));
        const out = el('button', '', 'Use a different account'); out.type = 'button'; out.id = 'stk-signout'; form.append(out);
      }
      const submit = el('button', 'primary', 'Claim my account');
      submit.type = 'submit';
      form.append(submit);
      panel.append(form);
      return panel;
    }
    if (me) {
      panel.append(el('div', 'eyebrow', 'Your account'), el('h2', '', me.full_name));
      if (me.player_number) panel.append(el('p', 'muted', 'Player number · ' + me.player_number));
      // Sign out lives on the top-right control now, not on this card.
      return panel;
    }
    panel.append(el('div', 'eyebrow', 'Your account'), el('h2', '', session ? 'Claim your player account' : 'Sign in'),
      el('p', 'muted', 'Open the private invite link STK sent you and enter your player number to claim your account.'));
    const action = el('button', '', session ? 'Sign out' : 'Sign in');
    action.id = session ? 'stk-signout' : 'stk-open-signin'; action.type = 'button'; panel.append(action);
    return panel;
  }

  function ordinal(n){const m=n%100;return n+(m>=11&&m<=13?'th':({1:'st',2:'nd',3:'rd'}[n%10]||'th'))}
function renderStats(p){statsMount.replaceChildren();statsMount.append(accountPanel());if(inviteToken || !me || !p || p.is_demo)return;const matches=p.matches,credits=p.credits;const innings=matches.reduce((n,m)=>n+m.innings,0),wins=matches.filter(m=>m.placement===1).length,bounties=credits.filter(c=>c.source==='bounty'&&c.change>0).reduce((n,c)=>n+c.change,0),earned=credits.filter(c=>c.change>0).reduce((n,c)=>n+c.change,0),used=-credits.filter(c=>c.change<0).reduce((n,c)=>n+c.change,0),balance=earned-used,bonus=Math.min(2,Math.max(0,wins-1));
const stats=el('section','panel');stats.append(el('h2','','Your game, by the numbers'),el('p','muted',p.is_demo?'Seeded profile stats':'Player stats'));const grid=el('div','stats-grid');for(const [value,label,detail] of [[innings,'Innings survived','Across '+matches.length+' matches'],[wins,'Wins','Championship qualified'],[bounties,'Bounties claimed','Extra lives earned'],[matches.length?(innings/matches.length).toFixed(1):'0','Innings per match','Average completed turns']]){const cell=el('div');cell.append(el('strong','',String(value)),el('span','',label),el('p','muted',detail));grid.append(cell)}stats.append(grid);statsMount.append(stats);
const tracker=el('section','panel');tracker.append(el('div','eyebrow','Extra life tracker'),el('h2','','Your lives. Your receipts.'));const balances=el('div','credit-balances');for(const [label,value,detail] of [['Regular-match credits',balance,'Available to use'],['Championship lives',wins?3+bonus:0,wins?'3 base + '+bonus+' bonus':'Win a match to qualify']]){const box=el('div');box.append(el('span','muted',label),el('strong','',String(value)),el('span','',detail));balances.append(box)}tracker.append(balances,el('p','muted',earned+' earned · '+used+' used · '+balance+' remaining'));const sources=el('div','statrow');for(const [key,label] of [['bar','Bar purchases'],['bounty','Bounties'],['referral','Friends referred']]){const box=el('div');box.append(el('strong','',String(credits.filter(c=>c.source===key&&c.change>0).reduce((n,c)=>n+c.change,0))),el('span','muted',label));sources.append(box)}tracker.append(sources,el('p','winner-note','Regular-match credits stay separate from championship lives. Championship bonus lives come only from wins.'));const details=el('details');details.open=true;details.append(el('summary','','Credit history'));for(const c of credits){const row=el('div','ledger-row');const text=el('div');text.append(el('h3','',({bar:'Bar purchases',bounty:'Bounty',referral:'Friend referral',used:'Life used'})[c.source]||c.source),el('p','muted',c.detail));row.append(text,el('span','credit-change',(c.change>0?'+':'')+c.change+' life'));details.append(row)}tracker.append(details);statsMount.append(tracker);
const history=el('section','panel');history.append(el('h2','','Match history'),el('p','muted',p.is_demo?'Seeded results · First to last elimination order':'First to last elimination order'));for(const m of matches){const row=el('div','history-item');row.append(el('h3','',m.label));const facts=el('div','history-facts');facts.append(el('span','',m.innings+' innings survived'),el('span','',ordinal(m.placement)+' of '+m.players));const order=m.players-m.placement+1;const result=m.placement===1?'Last standing · Winner':m.placement===m.players?'First eliminated':m.placement===2?'Last eliminated · '+ordinal(order)+' of '+(m.players-1):ordinal(order)+' eliminated of '+(m.players-1);row.append(facts,el('p','muted',result));history.append(row)}statsMount.append(history);icons()}

  async function refreshFeed() {
    const fresh = await window.STKData.load();
    data = fresh; me = fresh.me; session = await window.STKData.auth.session(); attendance = fresh.attendance; games = fresh.calendar;
    results = fresh.winners; seedCandidatesByVenue = fresh.seedCandidatesByVenue; now = fresh.seed_reference_time;
    isAdmin = fresh.is_admin === true;
    applyIdentity(); renderFeed(fresh.feed); renderStats(fresh.profile); updateRsvps(); renderBoard();
    reportLoadErrors(fresh);
    await initializeInvite();
  }
  function reportLoadErrors(payload) {
    if (payload.errors && payload.errors.length) $('#stk-status').textContent = payload.errors[0];
  }

  root.addEventListener('click', async e => {
    if (e.target.closest('#stk-account-button')) {
      if (me) {
        // Top-right is the auth action, not a profile shortcut. Profile has its
        // own nav tab; keeping this one control tied to signing in/out lets a
        // signed-in member sign out from anywhere, including inside the feed.
        const res = await window.STKData.auth.signOut();
        if (res.error) { $('#stk-status').textContent = res.error.message; return; }
        await refreshFeed();
        navigate(inviteToken ? 'profile' : 'feed');
        return;
      }
      if (session) { navigate('profile'); return; }
      openSignIn();
      return;
    }
    if (e.target.closest('#stk-open-signin')) { openSignIn(); return; }
    if (e.target.closest('#stk-auth-close')) { dialog.close(); return; }
    const view = e.target.closest('[data-view],[data-help-view]');
    if (view) { e.preventDefault(); navigate(view.dataset.view || view.dataset.helpView); return; }
    const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-rsvp')) {
      const game = games[Number(b.dataset.rsvp)]; if (!game) return;
      if (!me) { $('#stk-status').textContent = 'Sign in to RSVP.'; return; }
      const going = b.getAttribute('aria-pressed') !== 'true';
      const res = await window.STKData.writes.rsvp({ gameId: game.id, playerId: me.id, going });
      if (res.error) { $('#stk-status').textContent = 'Could not update RSVP: ' + res.error; return; }
      attendance = await (async () => (await window.STKData.load()).attendance)();
      updateRsvps(); renderBoard();
      $('#stk-status').textContent = going ? 'RSVP confirmed.' : 'RSVP canceled.';
    }
    if (b.hasAttribute('data-delete')) {
      const postId = b.closest('article').dataset.postId;
      if (isDerived(postId)) { $('#stk-status').textContent = DERIVED_NOTE; return; }
      $('#stk-status').textContent = 'Removing…';
      const res = await window.STKData.writes.removePost(postId);
      if (res.error) { $('#stk-status').textContent = 'Could not remove that post: ' + res.error; return; }
      await refreshFeed();
      $('#stk-status').textContent = 'Post removed.';
      return;
    }
    if (b.hasAttribute('data-delete-comment')) {
      $('#stk-status').textContent = 'Removing…';
      const res = await window.STKData.writes.removeComment(b.dataset.deleteComment);
      if (res.error) { $('#stk-status').textContent = 'Could not remove that comment: ' + res.error; return; }
      await refreshFeed();
      $('#stk-status').textContent = 'Comment removed.';
      return;
    }
    if (b.hasAttribute('data-share')) {
      const article = b.closest('article');
      const postId = article ? article.dataset.postId : null;
      if (!postId || isDerived(postId)) { $('#stk-status').textContent = 'This post does not have a permanent link yet.'; return; }
      const post = data.feed.find(p => p.id === postId);
      const shareUrl = 'https://stkpoolleague.com/social/post/' + postId;
      const shareTitle = (post && post.meta_label) ? post.meta_label : 'Shoot to Kill Pool League';
      const shareText = (post && post.body) ? post.body.slice(0, 140) : 'Check out this post on the STK feed.';
      if (navigator.share) {
        navigator.share({ title: shareTitle, text: shareText, url: shareUrl }).catch(() => {});
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(shareUrl).then(() => {
          const prev = b.textContent;
          b.textContent = 'Link copied!';
          setTimeout(() => { b.innerHTML = '<i data-lucide="share-2" aria-hidden="true"></i>Share'; icons(); }, 2000);
          $('#stk-status').textContent = 'Link copied to clipboard.';
          setTimeout(() => { if ($('#stk-status').textContent === 'Link copied to clipboard.') $('#stk-status').textContent = ''; }, 2000);
        }).catch(() => { $('#stk-status').textContent = 'Could not copy the link. Try long-pressing it.'; });
      } else {
        $('#stk-status').textContent = shareUrl;
      }
      return;
    }
    if (b.hasAttribute('data-like')) {
      const article = b.closest('article'), postId = article.dataset.postId;
      if (isDerived(postId)) { $('#stk-status').textContent = DERIVED_NOTE; return; }
      if (!me) { $('#stk-status').textContent = 'Sign in to like posts.'; return; }
      const on = b.getAttribute('aria-pressed') === 'true';
      const count = b.querySelector('span');
      b.setAttribute('aria-pressed', String(!on));
      count.textContent = Number(count.textContent) + (on ? -1 : 1);
      const res = await window.STKData.writes.like({ postId, playerId: me.id, on: !on });
      if (res.error) {
        b.setAttribute('aria-pressed', String(on));
        count.textContent = Number(count.textContent) + (on ? 1 : -1);
        $('#stk-status').textContent = 'Could not save that like.';
      }
    }
    if (b.hasAttribute('data-follow')) {
      const on = b.getAttribute('aria-pressed') === 'true'; b.setAttribute('aria-pressed', String(!on)); b.textContent = on ? 'Follow' : 'Following';
    }
    if (b.hasAttribute('data-comment')) {
      const comments = b.closest('article').querySelector('.comments'); comments.hidden = !comments.hidden;
      if (!comments.hidden) comments.querySelector('input').focus();
    }
    if (b.id === 'stk-clear-photos') { attachments = []; attachedFiles = []; renderAttachments(); }
    if (b.id === 'stk-signout') { const res = await window.STKData.auth.signOut(); if (res.error) { $('#stk-status').textContent = res.error.message; return; } await refreshFeed(); navigate(inviteToken ? 'profile' : 'feed'); }
    if (b.id === 'stk-feedback-again') {
      $('#stk-feedback-form').reset(); $('#stk-feedback-form').hidden = false; $('#stk-feedback-confirm').hidden = true;
      $('#stk-feedback-message').focus();
    }
  });

  root.addEventListener('submit', async e => {
    e.preventDefault(); const form = e.target;
    if (form.id === 'stk-compose') {
      if (preparing) { $('#stk-compose-status').textContent = 'Photos are still preparing.'; return; }
      if (!me) { $('#stk-compose-status').textContent = 'Sign in to post. Open the invite link STK sent you.'; return; }
      const text = $('#stk-post').value.trim();
      if (!text && !attachments.length) { $('#stk-compose-status').textContent = 'Write something or add a photo first.'; return; }
      $('#stk-compose-status').textContent = 'Posting…';
      const res = await window.STKData.writes.createPost({
        playerId: me.id, authorName: me.full_name, files: attachedFiles, text, logoSrc: assets.logo,
      });
      if (res.error) { $('#stk-compose-status').textContent = 'Could not post: ' + res.error; return; }
      $('#stk-post').value = ''; attachments = []; attachedFiles = []; renderAttachments();
      await refreshFeed();
      $('#stk-compose-status').textContent = 'Posted.';
    } else if (form.classList.contains('comment-form')) {
      const input = form.querySelector('input'), text = input.value.trim(); if (!text) return;
      if (!me) { $('#stk-status').textContent = 'Sign in to comment.'; return; }
      const postId = form.closest('article').dataset.postId;
      if (isDerived(postId)) { $('#stk-status').textContent = DERIVED_NOTE; return; }
      const res = await window.STKData.writes.comment({ postId, playerId: me.id, authorName: me.full_name, body: text });
      if (res.error) { $('#stk-status').textContent = 'Could not save that comment.'; return; }
      form.before(el('p', '', me.full_name + ' · ' + text)); input.value = '';
    } else if (form.id === 'stk-feedback-form') {
      const message = $('#stk-feedback-message').value.trim();
      if (message.length < 5) { $('#stk-feedback-message').setCustomValidity('Please add a little more detail.'); $('#stk-feedback-message').reportValidity(); return; }
      const category = $('#stk-feedback-category').value, email = $('#stk-feedback-email').value.trim();
      if (!me) { $('#stk-feedback-message').setCustomValidity('Sign in to send feedback.'); $('#stk-feedback-message').reportValidity(); return; }
      const res = await window.STKData.writes.feedback({ playerId: me.id, category, message, email });
      if (res.error) { $('#stk-feedback-message').setCustomValidity('Could not send: ' + res.error); $('#stk-feedback-message').reportValidity(); return; }
      feedbackDrafts.push({ category, message, email, created_at: new Date().toISOString(), status: 'sent' });
      form.hidden = true; $('#stk-feedback-confirm').hidden = false;
    } else if (form.id === 'stk-signin-form') {
      const status = $('#stk-signin-status');
      const submit = form.querySelector('button[type="submit"]');
      if (submit.disabled) return;
      submit.disabled = true; status.textContent = 'Signing in…';
      try {
        const { error } = await window.STKData.auth.signIn($('#stk-signin-email').value.trim(), $('#stk-signin-password').value);
        if (error) { status.textContent = error.message; return; }
        dialog.close(); await refreshFeed();
        status.textContent = '';
      } catch { status.textContent = 'Could not sign in. Check your connection and try again.'; }
      finally { submit.disabled = false; }
    } else if (form.id === 'stk-claim-form') {
      const status = $('#stk-claim-status');
      if (claimBusy) return;
      claimBusy = true; status.textContent = 'Claiming…';
      let res;
      try { res = await window.STKData.auth.claim({
        token: inviteToken,
        playerNumber: $('#stk-claim-number').value.trim(),
        fullName: $('#stk-claim-name').value.trim(),
        phone: $('#stk-claim-phone').value.trim(),
        email: session ? (session.user.email || '') : $('#stk-claim-email').value.trim(),
        password: session ? '' : $('#stk-claim-password').value,
      }); } catch { res = { error: 'Could not claim your account. Check your connection and try again.' }; }
      finally { claimBusy = false; }
      if (res.error) { status.textContent = res.error; return; }
      location.href = location.pathname;
    }
  });
  $('#stk-feedback-message').addEventListener('input', e => e.target.setCustomValidity(''));

  window.STKSeed = {
    getFeedPayload: () => JSON.parse(JSON.stringify(data.feedPayload)),
    getSampleProfile: () => JSON.parse(JSON.stringify(data.profile)),
    setProfileData: renderStats,
    getFeedbackDrafts: () => JSON.parse(JSON.stringify(feedbackDrafts)),
    getBountyBoard: getBoard,
    reload: refreshFeed,
    setRosterSnapshot(snapshot) {
      if (!Array.isArray(snapshot.attendance)) throw new Error('Supply a current attendance snapshot.');
      attendance = snapshot.attendance;
      if (snapshot.games) games = snapshot.games;
      if (snapshot.results) results = snapshot.results;
      if (snapshot.seedCandidatesByVenue) seedCandidatesByVenue = snapshot.seedCandidatesByVenue;
      now = snapshot.now || new Date().toISOString();
      updateRsvps(); renderBoard();
    }
  };

  renderFeed(data.feed);
  renderStats(data.profile);
  updateRsvps();
  renderBoard();
  applyIdentity();
  navigate(linkedPostId ? 'feed' : (inviteToken ? 'profile' : 'feed'));
  icons();
  reportLoadErrors(data);

  // Resolve the scoreboard nav to a live match or an inactive state.
  // Runs async and never blocks the rest of the page.
  (async function resolveScoreboardNav() {
    var nav = document.getElementById('stk-scoreboard-nav');
    if (!nav) return;
    try {
      var session = await window.STKData.loadLiveSession();
      if (session && session.kind === 'live') {
        var a = document.createElement('a');
        a.id = 'stk-scoreboard-nav';
        a.href = 'https://stkscore.live/live/' + session.id;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.setAttribute('aria-label', 'Scoreboard (opens in a new tab)');
        a.className = 'live';
        a.innerHTML = nav.innerHTML;
        nav.parentNode.replaceChild(a, nav);
      } else if (session && session.kind === 'scheduled') {
        // A match is on the calendar for tonight but no scoreboard has spun up
        // yet. Take the reader to a branded holding page rather than lie with
        // "no match tonight". Populating the venue/time up here saves the
        // holding page an extra fetch.
        var b = document.createElement('button');
        b.id = 'stk-scoreboard-nav';
        b.type = 'button';
        b.setAttribute('data-view', 'scoreboard-pending');
        b.setAttribute('aria-label', 'Scoreboard (opens once the match starts)');
        b.className = 'live';
        b.innerHTML = nav.innerHTML;
        b.querySelector('span').textContent = 'Scoreboard';
        nav.parentNode.replaceChild(b, nav);
        var venue = $('#stk-pending-venue');
        var when = $('#stk-pending-when');
        if (venue) venue.textContent = session.venue_name || 'Tonight';
        if (when && session.start_time) {
          var t = String(session.start_time).slice(0, 5).split(':');
          var h = parseInt(t[0], 10);
          var m = t[1];
          var suffix = h >= 12 ? 'PM' : 'AM';
          var hh = ((h + 11) % 12) + 1;
          when.textContent = 'Tonight · ' + hh + (m === '00' ? '' : ':' + m) + ' ' + suffix;
        } else if (when) {
          when.textContent = 'Tonight';
        }
      } else {
        nav.querySelector('span').textContent = 'No match tonight';
        nav.setAttribute('aria-label', 'No match is live tonight');
      }
    } catch (err) {
      // A failed lookup is not the same state as no match running, and the two
      // call for different action, so they must never share a label.
      var span = nav.querySelector('span');
      if (span) span.textContent = 'Scoreboard unavailable';
      nav.setAttribute('aria-label', 'Scoreboard is temporarily unavailable');
    }
  }());

  async function initializeInvite() {
    if (!inviteToken) return;
    const status = $('#stk-claim-status'), form = $('#stk-claim-form');
    if (!status) return;
    const retry = 'Could not check this invite. Check your connection and try again.';
    let timer;
    let preview;
    try {
      preview = await Promise.race([
        Promise.resolve().then(() => window.STKData.auth.previewInvite(inviteToken)),
        new Promise(resolve => { timer = setTimeout(() => resolve({ error: retry }), invitePreviewTimeout); }),
      ]);
    } catch {
      preview = { error: retry };
    } finally {
      clearTimeout(timer);
    }
    preview = preview || { state: 'unknown' };
    const messages = {
      live: null,
      used: 'This invite has already been used. Sign in instead.',
      expired: 'This invite has expired. Ask STK for a new link.',
      revoked: 'This invite was cancelled. Ask STK for a new link.',
      claimed: 'This account is already claimed. Sign in instead.',
      unknown: 'We could not find that invite. Check the link.',
    };
    if (preview.error) {
      status.textContent = preview.error;
      return;
    }
    if (messages[preview.state]) {
      status.textContent = messages[preview.state];
      if (form) form.hidden = true;
      return;
    }
    if (me && session) {
      status.textContent = 'This invite has not been claimed.';
      return;
    }
    status.textContent = invitePlayerNumber
      ? 'Invite confirmed. Complete the form to claim player #' + invitePlayerNumber + '.'
      : 'Invite confirmed. Enter the player number STK sent you.';
    if (form) form.hidden = false;
  }
  await initializeInvite();
})();
