import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = 'https://cxzicermzwymgobvvhwk.supabase.co';
const SUPABASE_KEY = 'sb_publishable_dReCg6jN107EwowinBcPbw_Nda00ZlS';
const SERIES_TZ = 'America/New_York';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'stk-social-auth' },
});

const initials = name => String(name || '').trim().split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase() || '?';

// Read failures are reported, never swallowed: load() returns them and the app
// prints the first one into the existing #stk-status line.
const loadErrors = [];

// League cards are authored by the league, not by a player account.
const LEAGUE_AUTHOR = { author_name: 'Shoot to Kill', author_initials: 'STK', author_is_bounty: false };

const dayLabel = iso => new Date(iso).toLocaleString('en-US', { timeZone: SERIES_TZ, month: 'short', day: 'numeric' });

// "Today" in the league's timezone. UTC rolls over at 8pm ET, which hid the
// current night's match from Upcoming and from the scoreboard nav.
function todayInSeriesTz() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SERIES_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function todayStartUtcIso() {
  return startsAt(todayInSeriesTz(), '00:00:00', SERIES_TZ);
}

// scheduled_games stores date, time and IANA zone separately; build a real instant.
function zoneOffset(instant, zone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of fmt.formatToParts(instant)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUTC - instant.getTime();
}

function startsAt(date, time, zone) {
  const tz = zone || SERIES_TZ;
  const guess = new Date(`${date}T${time || '00:00:00'}Z`);
  return new Date(guess.getTime() - zoneOffset(guess, tz)).toISOString();
}

// match_winners can carry correction revisions; keep only the newest per match.
function latestRevisions(rows) {
  const best = new Map();
  for (const r of rows) {
    const prior = best.get(r.match_id);
    if (!prior || r.revision > prior.revision) best.set(r.match_id, r);
  }
  return Array.from(best.values());
}

async function currentPlayer() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data } = await sb.from('players').select('id, full_name, player_number, email, phone').eq('user_id', user.id).maybeSingle();
  return data ? { ...data, user_id: user.id, email: data.email || user.email } : null;
}

async function loadCalendar() {
  const { data: series } = await sb.from('series').select('id, name, timezone, is_active').eq('is_active', true).limit(1);
  const active = series && series[0];
  const { data: games } = await sb
    .from('scheduled_games')
    .select('id, title, venue_id, venue_name, venue_address, scheduled_date, start_time, timezone, status, series_id, match_id')
    .eq('status', 'scheduled')
    .order('scheduled_date', { ascending: true })
    .order('start_time', { ascending: true });
  const today = todayInSeriesTz();
  return (games || [])
    .filter(g => g.scheduled_date >= today)
    .map(g => ({
      id: g.id,
      series_id: g.series_id || (active && active.id) || null,
      venue_id: g.venue_id,
      venue_name: g.venue_name || 'TBA',
      venue_address: g.venue_address || '',
      scheduled_date: g.scheduled_date,
      start_time: g.start_time,
      status: g.status,
      starts_at: startsAt(g.scheduled_date, g.start_time, g.timezone || (active && active.timezone)),
    }));
}

// match_winners.player_id is a session_players row id, not a person. Resolve the
// canonical players.id where the roster row was linked, so one human is one id.
async function loadWinners() {
  const { data, error } = await sb
    .from('match_winners')
    .select('match_id, player_id, player_name, points, event_name, won_at, revision, voided')
    .eq('voided', false)
    .order('won_at', { ascending: false });
  if (error) loadErrors.push('Could not read match results: ' + error.message);
  // A superseded revision can carry a different spelling of the same winner
  // ("Duke" became "Duc"). Keep every spelling so an already-published card is
  // recognised as covering the match and is not duplicated.
  const namesByMatch = new Map();
  for (const r of data || []) {
    const list = namesByMatch.get(r.match_id) || [];
    const name = String(r.player_name || '').toUpperCase();
    if (name && !list.includes(name)) list.push(name);
    namesByMatch.set(r.match_id, list);
  }
  const rows = latestRevisions(data || []);
  const seatIds = rows.map(r => r.player_id).filter(Boolean);
  const canonical = new Map();
  if (seatIds.length) {
    const { data: seats } = await sb.from('session_players').select('id, player_id').in('id', seatIds);
    for (const s of seats || []) if (s.player_id) canonical.set(s.id, s.player_id);
  }
  const list = rows.map(r => ({
    player_id: canonical.get(r.player_id) || r.player_id,
    player_name: r.player_name,
    points: r.points,
    event_name: r.event_name,
    won_at: r.won_at,
    match_id: r.match_id,
    voided: false,
  }));
  return { list, namesByMatch };
}

// Scoring tables are read-only from here. bounty_claims is anon SELECT only.
async function loadBountyClaims() {
  const { data, error } = await sb
    .from('bounty_claims')
    .select('id, session_id, target_name, target_reason, claimant_name, round, created_at, voided')
    .eq('voided', false)
    .order('created_at', { ascending: false });
  if (error) loadErrors.push('Could not read bounty claims: ' + error.message);
  return data || [];
}

async function loadAttendance(playerId) {
  if (!playerId) return [];
  const { data } = await sb.from('rsvps').select('game_id, player_id, created_at').eq('player_id', playerId);
  return (data || []).map(r => ({
    game_id: r.game_id,
    player_id: r.player_id,
    player_name: '',
    status: 'confirmed',
    updated_at: r.created_at,
  }));
}

async function loadProfile(playerId) {
  if (!playerId) return { is_demo: false, matches: [], credits: [] };
  const { data: seats } = await sb
    .from('session_players')
    .select('id, session_id, final_placement, eliminated_round')
    .eq('player_id', playerId);
  const sessionIds = (seats || []).map(s => s.session_id);
  let byMatch = new Map();
  if (sessionIds.length) {
    const { data: done } = await sb
      .from('completed_matches')
      .select('match_id, event_name, completed_at, final_round, player_count, revision')
      .in('match_id', sessionIds);
    for (const m of latestRevisions(done || [])) byMatch.set(m.match_id, m);
  }
  const matches = (seats || [])
    .map(s => {
      const m = byMatch.get(s.session_id);
      if (!m) return null;
      // No per-turn log exists. Innings survived = the round the player went out,
      // or the match's final round for the last one standing.
      const innings = s.eliminated_round || m.final_round || 0;
      return {
        label: m.event_name,
        innings,
        players: m.player_count,
        placement: s.final_placement,
        completed_at: m.completed_at,
      };
    })
    .filter(m => m && m.placement)
    .sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at));

  const { data: rawCredits } = await sb
    .from('referral_credits')
    .select('kind, source, referred_name, note, occurred_on, expired_at')
    .eq('player_id', playerId)
    .is('expired_at', null)
    .order('occurred_on', { ascending: false });
  const credits = (rawCredits || []).map(c => ({
    source: c.kind === 'spent' ? 'used' : ({ referral: 'referral', bounty: 'bounty', bar_tab: 'bar' })[c.source] || c.source,
    change: c.kind === 'spent' ? -1 : 1,
    detail: c.note || c.referred_name || '',
  }));
  return { is_demo: false, matches, credits };
}

async function loadFeed() {
  const { data, error } = await sb
    .from('social_posts')
    .select('id, author_player_id, author_name, author_initials, author_is_bounty, meta_label, body, card, match_id, source, created_at, social_post_media(url, alt, label, watermarked, position), social_comments(id, author_name, body, created_at), social_likes(player_id)')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) loadErrors.push('Could not read the feed: ' + error.message);
  return (data || []).map(p => ({
    id: p.id,
    author_player_id: p.author_player_id,
    author_name: p.author_name,
    author_initials: p.author_initials,
    author_is_bounty: p.author_is_bounty,
    meta_label: p.meta_label,
    body: p.body,
    card: p.card,
    match_id: p.match_id,
    source: p.source,
    created_at: p.created_at,
    derived: false,
    media: (p.social_post_media || []).slice().sort((a, b) => a.position - b.position),
    comments: (p.social_comments || []).slice().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
    likes: (p.social_likes || []).map(l => l.player_id),
  }));
}

// ---- league cards derived from the scoring tables -------------------------
// The scoring app owns match_winners and bounty_claims and this prototype only
// reads them. A card is built for every non-voided row, then suppressed if a
// social_posts row already covers it. Only an admin can persist one: RLS lets
// members insert source='member' rows only.
async function isAdmin() {
  const { data, error } = await sb.rpc('is_admin');
  if (error) return false;
  return data === true;
}

// Admins can see soft-deleted rows through their own policy, so a card an admin
// removed stays suppressed for them. Anon only sees live rows.
async function loadLeagueKeyRows() {
  const { data } = await sb
    .from('social_posts')
    .select('id, meta_label, card, match_id, deleted_at')
    .eq('source', 'league')
    .limit(500);
  return data || [];
}

function publishedKeys(rows) {
  const keys = new Set();
  for (const p of rows) {
    const card = p.card || {};
    if (card.source_key) keys.add(card.source_key);
    if (p.match_id) keys.add('winner:' + p.match_id);
    // Cards seeded before source_key existed are matched on what they display.
    if (card.name) keys.add('label:' + p.meta_label + '|' + String(card.name).toUpperCase());
    if (card.headline) keys.add('headline:' + String(card.headline).toUpperCase());
  }
  return keys;
}

function winnerCard(w, index) {
  const name = String(w.player_name || '').toUpperCase();
  return {
    key: 'winner:' + w.match_id,
    labelKey: 'label:' + w.event_name + ' · ' + dayLabel(w.won_at) + '|',
    match_id: w.match_id,
    post: Object.assign({}, LEAGUE_AUTHOR, {
      meta_label: w.event_name + ' · ' + dayLabel(w.won_at),
      body: w.player_name + ' takes the win. Championship ticket secured. Bounty activated.',
      card: {
        type: 'winner_poster',
        eyebrow: 'Match complete / Winners circle',
        title_lines: ['ROOM CONQUERED.', 'TICKET PUNCHED.'],
        name,
        bounty: true,
        note: (w.points == null ? 0 : w.points) + ' points · Championship qualifier',
        medal: 'W',
        alt: index % 2 === 0,
        source_key: 'winner:' + w.match_id,
      },
      match_id: w.match_id,
      source: 'league',
      created_at: w.won_at,
    }),
  };
}

// The life goes to whoever shot immediately before the target went out, and
// only while that claimant is still on the board. bounty_claims already stores
// the resolved claimant, so the card reports it rather than re-deriving it.
function bountyCard(c) {
  const claimant = String(c.claimant_name || '').trim() || 'A player';
  const target = String(c.target_name || '').trim() || 'a bounty target';
  const reason = c.target_reason === 'host' ? 'Host bounty' : 'Previous winner bounty';
  const headline = claimant.toUpperCase() + ' TOOK OUT ' + target.toUpperCase() + '.';
  return {
    key: 'bounty:' + c.id,
    headlineKey: 'headline:' + headline,
    match_id: null,
    post: Object.assign({}, LEAGUE_AUTHOR, {
      meta_label: 'League recap · Bounty claimed',
      body: claimant + ' eliminated ' + target + ' and earned a bounty bonus.',
      card: {
        type: 'reward',
        eyebrow: 'Bounty bonus',
        headline,
        big: '+1 LIFE',
        note: reason + ' · +1 regular-match credit · Championship lives unchanged',
        frame: 'reward-card',
        source_key: 'bounty:' + c.id,
      },
      // Two claims can land in one session, so these carry no match_id: the
      // unique index on (match_id, meta_label) would reject the second.
      match_id: null,
      source: 'league',
      created_at: c.created_at,
    }),
  };
}

function pendingLeagueCards({ winners, namesByMatch, claims, leagueRows }) {
  const keys = publishedKeys(leagueRows);
  const pending = [];
  winners.forEach((w, i) => {
    if (!w.match_id || !w.won_at) return;
    const card = winnerCard(w, i);
    if (keys.has(card.key)) return;
    const names = namesByMatch.get(w.match_id) || [String(w.player_name || '').toUpperCase()];
    if (names.some(n => keys.has(card.labelKey + n))) return;
    pending.push(card);
  });
  for (const c of claims) {
    if (!c.id || !c.created_at) continue;
    const card = bountyCard(c);
    if (keys.has(card.key) || keys.has(card.headlineKey)) continue;
    pending.push(card);
  }
  return pending;
}

// Rendered stand-ins for cards that have no social_posts row yet. They show the
// same markup as a stored card; likes, comments and deletes need a real row.
function asFeedPost(card) {
  return Object.assign({}, card.post, {
    id: 'derived:' + card.key,
    author_player_id: null,
    derived: true,
    media: [],
    comments: [],
    likes: [],
  });
}

function seedCandidates(winners, calendar) {
  // Unlinked rosters give the same human a different session_players id each match,
  // so the id alone would list one winner twice. Collapse on name as well.
  const seen = [], names = [];
  for (const w of winners) {
    const name = (w.player_name || '').trim().toLowerCase();
    if (!w.player_id || seen.includes(w.player_id) || names.includes(name)) continue;
    seen.push(w.player_id);
    names.push(name);
  }
  const top = seen.slice(0, 3);
  const byVenue = {};
  for (const g of calendar) if (g.venue_id) byVenue[g.venue_id] = top;
  return byVenue;
}

export async function load() {
  loadErrors.length = 0;
  const me = await currentPlayer();
  const [calendar, winnerData, claims, admin] = await Promise.all([
    loadCalendar(), loadWinners(), loadBountyClaims(), isAdmin(),
  ]);
  const winners = winnerData.list;
  let [feedRows, leagueRows] = await Promise.all([loadFeed(), loadLeagueKeyRows()]);
  let pending = pendingLeagueCards({ winners, namesByMatch: winnerData.namesByMatch, claims, leagueRows });

  // Publishing is the admin's write. Everyone else sees the same cards rendered
  // straight from the scoring tables until an admin session stores them.
  if (admin && pending.length) {
    const { error } = await sb.from('social_posts').insert(pending.map(p => p.post));
    if (error) loadErrors.push('Could not publish league cards: ' + error.message);
    else {
      [feedRows, leagueRows] = await Promise.all([loadFeed(), loadLeagueKeyRows()]);
      pending = pendingLeagueCards({ winners, namesByMatch: winnerData.namesByMatch, claims, leagueRows });
    }
  }

  const feed = feedRows.concat(pending.map(asFeedPost))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

  const [attendance, profile] = await Promise.all([
    loadAttendance(me && me.id),
    loadProfile(me && me.id),
  ]);
  return {
    me,
    is_admin: admin,
    errors: loadErrors.slice(),
    calendar,
    winners,
    bountyClaims: claims,
    attendance,
    profile,
    feed,
    seed_reference_time: new Date().toISOString(),
    seedCandidatesByVenue: seedCandidates(winners, calendar),
    feedPayload: {
      schema_version: 1,
      import_mode: 'live',
      events: feed.filter(p => p.source === 'league').map(p => ({
        source_key: p.id,
        kind: p.card && p.card.type === 'reward' ? 'reward' : 'match_win',
        headline: (p.card && (p.card.headline || (p.card.title_lines || []).join(' '))) || '',
        body: p.body,
        detail: (p.card && p.card.note) || '',
        occurred_at: p.created_at,
        provenance: 'league_owner',
        confirmed: true,
      })),
      drafts: feed.filter(p => p.source === 'member').map(p => ({ id: p.id, body: p.body, author: p.author_name })),
      award_gameplay_credits: false,
    },
  };
}

export const auth = {
  client: sb,
  onChange(fn) { sb.auth.onAuthStateChange((_e, session) => fn(session)); },
  async session() { return (await sb.auth.getSession()).data.session; },
  async me() { return currentPlayer(); },
  async isAdmin() { return isAdmin(); },
  async signIn(email, password) { return sb.auth.signInWithPassword({ email, password }); },
  async signOut() { return sb.auth.signOut(); },
  async previewInvite(token) {
    // This lookup is deliberately anonymous. Going through the persistent
    // Supabase client can wait behind its auth-session initialization lock,
    // leaving a signed-out claimant on "Checking your invite…" indefinitely.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/player_invite_preview`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_token: token }),
        signal: controller.signal,
      });
      if (!response.ok) return { error: 'Could not check this invite. Try again.' };
      const data = await response.json();
      return (data && data[0]) || { state: 'unknown' };
    } catch {
      return { error: 'Could not check this invite. Check your connection and try again.' };
    } finally {
      clearTimeout(timeout);
    }
  },
  async claim({ token, playerNumber, email, password, fullName, phone }) {
    const cleanToken = String(token || '').trim().toLowerCase();
    const cleanNumber = String(playerNumber || '').trim();
    const maxBigint = '9223372036854775807';
    if (!/^[0-9a-f]{64}$/.test(cleanToken)
        || !/^[1-9][0-9]*$/.test(cleanNumber)
        || cleanNumber.length > maxBigint.length
        || (cleanNumber.length === maxBigint.length && cleanNumber > maxBigint)) {
      return { error: 'Enter the player number from your STK invite.' };
    }
    try {
      let existing = (await sb.auth.getSession()).data.session;
      const cleanEmail = String(email || '').trim().toLowerCase();
      if (existing) {
        const sessionEmail = String(existing.user && existing.user.email || '').trim().toLowerCase();
        if (!sessionEmail || (cleanEmail && cleanEmail !== sessionEmail)) {
          return { error: 'Sign out and use the email address for this account.' };
        }
      } else {
        const { data: signUpData, error: signUpError } = await sb.auth.signUp({ email: cleanEmail, password });
        if (signUpError) return { error: signUpError.message };
        existing = signUpData && signUpData.session;
        if (!existing) return { error: 'Account created. Confirm your email, then sign in to finish claiming.' };
      }
      const { data, error } = await sb.rpc('claim_player_invite', {
        p_token: cleanToken,
        p_player_number: cleanNumber,
        p_full_name: fullName,
        p_phone: phone,
      });
      if (error) return { error: error.message };
      return { player_id: data };
    } catch {
      return { error: 'Could not claim your account. Check your connection and try again.' };
    }
  },
};

// The STK mark is composited into the pixels before upload; there is no server
// to do it after the fact.
async function watermark(file, logoSrc) {
  const bitmap = await createImageBitmap(file);
  const max = 1600;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (logoSrc) {
    const logo = await new Promise((res, rej) => {
      const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = logoSrc;
    });
    const size = Math.round(Math.min(w, h) * 0.18);
    const pad = Math.round(size * 0.45);
    ctx.globalAlpha = 0.85;
    ctx.drawImage(logo, w - size - pad, h - size - pad, size, size);
    ctx.globalAlpha = 1;
  }
  return new Promise(res => canvas.toBlob(b => res(b), 'image/jpeg', 0.9));
}

export const writes = {
  async createPost({ playerId, authorName, files, text, logoSrc }) {
    const { data: post, error } = await sb.from('social_posts').insert({
      author_player_id: playerId,
      author_name: authorName,
      author_initials: initials(authorName),
      meta_label: 'Just now',
      body: text,
      source: 'member',
    }).select('id').single();
    if (error) return { error: error.message };
    const media = [];
    for (let i = 0; i < files.length; i++) {
      const blob = await watermark(files[i], logoSrc);
      const path = `${playerId}/${Date.now()}-${i}.jpg`;
      const up = await sb.storage.from('social-media').upload(path, blob, { contentType: 'image/jpeg' });
      if (up.error) return { error: up.error.message };
      const { data: pub } = sb.storage.from('social-media').getPublicUrl(path);
      media.push({ post_id: post.id, url: pub.publicUrl, alt: `Photo ${i + 1} added by ${authorName}`, watermarked: true, position: i });
    }
    if (media.length) {
      const { error: mediaError } = await sb.from('social_post_media').insert(media);
      if (mediaError) return { error: mediaError.message };
    }
    return { id: post.id, media };
  },
  async comment({ postId, playerId, authorName, body }) {
    const { data, error } = await sb.from('social_comments')
      .insert({ post_id: postId, author_player_id: playerId, author_name: authorName, body })
      .select('id, author_name, body, created_at').single();
    return error ? { error: error.message } : data;
  },
  async like({ postId, playerId, on }) {
    const { error } = on
      ? await sb.from('social_likes').insert({ post_id: postId, player_id: playerId })
      : await sb.from('social_likes').delete().eq('post_id', postId).eq('player_id', playerId);
    return error ? { error: error.message } : { ok: true };
  },
  async rsvp({ gameId, playerId, going }) {
    const { error } = going
      ? await sb.from('rsvps').insert({ game_id: gameId, player_id: playerId })
      : await sb.from('rsvps').delete().eq('game_id', gameId).eq('player_id', playerId);
    return error ? { error: error.message } : { ok: true };
  },
  // Moderation is enforced by RLS, not by the button being on screen. A policy
  // that refuses returns no error and no rows, so an empty result is a refusal
  // and is reported as one. Hiding it away is soft-deleting; when the table
  // grants no UPDATE, fall back to the delete the schema does grant.
  async removePost(postId) {
    const hide = await sb.from('social_posts')
      .update({ deleted_at: new Date().toISOString() }).eq('id', postId).select('id');
    if (!hide.error && hide.data && hide.data.length) return { ok: true, mode: 'hidden' };
    const cut = await sb.from('social_posts').delete().eq('id', postId).select('id');
    if (cut.error) return { error: cut.error.message };
    if (!cut.data || !cut.data.length) {
      return { error: hide.error ? hide.error.message : 'the database refused it' };
    }
    return { ok: true, mode: 'deleted' };
  },
  async removeComment(commentId) {
    const hide = await sb.from('social_comments')
      .update({ deleted_at: new Date().toISOString() }).eq('id', commentId).select('id');
    if (!hide.error && hide.data && hide.data.length) return { ok: true, mode: 'hidden' };
    const cut = await sb.from('social_comments').delete().eq('id', commentId).select('id');
    if (cut.error) return { error: cut.error.message };
    if (!cut.data || !cut.data.length) {
      return { error: hide.error ? hide.error.message : 'the database refused it' };
    }
    return { ok: true, mode: 'deleted' };
  },
  async feedback({ playerId, category, message, email }) {
    const { error } = await sb.from('social_feedback').insert({ player_id: playerId, category, message, email: email || null });
    return error ? { error: error.message } : { ok: true };
  },
};

// The scoreboard chip is one control that reflects three real states so the
// feed never lies. A live scoring session wins; if none, tonight's scheduled
// game keeps the chip meaningful; if neither, the chip goes quiet. "Today" is
// resolved in the league's timezone so the gate does not slide at 8pm ET.
async function loadLiveSession() {
  const today = todayInSeriesTz();
  const { data: live, error: liveErr } = await sb
    .from('scoring_sessions')
    .select('id, event_name, status, created_at')
    .eq('status', 'active')
    .gte('created_at', todayStartUtcIso())
    .order('created_at', { ascending: false })
    .limit(1);
  if (!liveErr && live && live[0]) {
    return { kind: 'live', id: live[0].id, event_name: live[0].event_name };
  }
  const { data: scheduled, error: schErr } = await sb
    .from('scheduled_games')
    .select('id, venue_name, start_time')
    .eq('status', 'scheduled')
    .eq('scheduled_date', today)
    .order('start_time', { ascending: false })
    .limit(1);
  if (!schErr && scheduled && scheduled[0]) {
    return { kind: 'scheduled', venue_name: scheduled[0].venue_name, start_time: scheduled[0].start_time };
  }
  return null;
}

window.STKData = { load, auth, writes, initials, loadLiveSession };
