/**
 * build-post-pages.mjs
 *
 * Pre-renders one static HTML file per social post so scrapers (Facebook,
 * X, iMessage, Slack) read real Open Graph / Twitter Card meta tags.
 * Scrapers don't execute JS, so the tags must be in the initial HTML.
 *
 * Run: node build-post-pages.mjs
 * Expected output: "built N post pages"
 *
 * On any fatal error this throws so the caller's && chain breaks and
 * firebase deploy does not run.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Read Supabase credentials from stk-data.js — the same source of truth the
// deployed feed uses. We parse the two constants out of the JS source rather
// than importing it (it's a browser ES module with bare http imports).
// ---------------------------------------------------------------------------
const deployRoot = path.dirname(fileURLToPath(import.meta.url));
const stkDataPath = path.join(deployRoot, 'social', 'stk-data.js');

const stkDataSrc = await fs.readFile(stkDataPath, 'utf8');

function extractConst(src, name) {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`));
  if (!m) throw new Error(`Could not extract ${name} from ${stkDataPath}`);
  return m[1];
}

const SUPABASE_URL = extractConst(stkDataSrc, 'SUPABASE_URL');
const SUPABASE_KEY = extractConst(stkDataSrc, 'SUPABASE_KEY');

// ---------------------------------------------------------------------------
// HTML escape — applied to every interpolated value (title, description, alt)
// ---------------------------------------------------------------------------
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Truncate body to ≤200 chars on a word boundary
// ---------------------------------------------------------------------------
function truncate(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + '…';
}

// ---------------------------------------------------------------------------
// Fetch all posts from Supabase (single request — ~25 posts today, ~3/day)
// ---------------------------------------------------------------------------
const query = [
  'select=id,meta_label,body,card,author_name,social_post_media(url,alt,position)',
  'deleted_at=is.null',
  'order=created_at.desc',
].join('&');

const apiUrl = `${SUPABASE_URL}/rest/v1/social_posts?${query}`;

const res = await fetch(apiUrl, {
  headers: {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    Accept: 'application/json',
  },
});

if (!res.ok) {
  throw new Error(`Supabase request failed: ${res.status} ${res.statusText}`);
}

const posts = await res.json();

if (!Array.isArray(posts)) {
  throw new Error(`Unexpected Supabase response shape: ${JSON.stringify(posts).slice(0, 200)}`);
}

// Sort each post's media by position ascending (client-side as specified)
for (const post of posts) {
  if (Array.isArray(post.social_post_media)) {
    post.social_post_media.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  } else {
    post.social_post_media = [];
  }
}

// ---------------------------------------------------------------------------
// Load the template HTML once
// ---------------------------------------------------------------------------
const templatePath = path.join(deployRoot, 'social', 'index.html');
const templateHtml = await fs.readFile(templatePath, 'utf8');

// Splice point: insert OG tags immediately AFTER the viewport meta tag.
// The viewport tag text is known from the source.
const VIEWPORT_TAG = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';
if (!templateHtml.includes(VIEWPORT_TAG)) {
  throw new Error('Template HTML does not contain the expected viewport meta tag. Check social/index.html.');
}

// ---------------------------------------------------------------------------
// Guard: resolve post output directory and verify it is what we expect
// ---------------------------------------------------------------------------
const postDir = path.resolve(deployRoot, 'social', 'post');
const expectedPostDir = path.join(deployRoot, 'social', 'post');
if (postDir !== expectedPostDir) {
  throw new Error(`Safety check failed: resolved post dir "${postDir}" !== expected "${expectedPostDir}". Aborting.`);
}

// Delete only social/post/, nothing else
await fs.rm(postDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Build one file per post
// ---------------------------------------------------------------------------
let built = 0;

for (const post of posts) {
  const { id, meta_label, body, social_post_media } = post;

  if (!id) continue; // skip any malformed row

  // -- Compute OG values --

  const ogUrl = `https://stkpoolleague.com/social/post/${id}`;
  const ogSiteName = 'Shoot to Kill Pool League';
  const ogType = 'article';

  const rawTitle = (meta_label && meta_label.trim()) ? meta_label.trim() : 'Shoot to Kill Pool League';

  let rawDescription;
  const bodyText = (body && body.trim()) ? body.trim() : '';
  if (bodyText) {
    rawDescription = truncate(bodyText, 200);
  } else if (meta_label && meta_label.trim()) {
    rawDescription = meta_label.trim();
  } else {
    rawDescription = 'Kill Shot Pool League';
  }

  const firstMedia = social_post_media[0] || null;

  const ogImage = firstMedia
    ? firstMedia.url
    : 'https://stkpoolleague.com/assets/logo-skull-circle.png';

  const rawAlt = (firstMedia && firstMedia.alt && firstMedia.alt.trim())
    ? firstMedia.alt.trim()
    : rawTitle;

  const twitterCard = firstMedia ? 'summary_large_image' : 'summary';

  // -- HTML-escape all interpolated values --
  const title = esc(rawTitle);
  const description = esc(rawDescription);
  const image = esc(ogImage);
  const imageAlt = esc(rawAlt);
  const url = esc(ogUrl);
  const siteName = esc(ogSiteName);

  // -- Build the OG tag block --
  const ogBlock = [
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:site_name" content="${siteName}">`,
    `<meta property="og:type" content="${ogType}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:image" content="${image}">`,
    `<meta property="og:image:alt" content="${imageAlt}">`,
    `<meta name="twitter:card" content="${twitterCard}">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${image}">`,
  ].join('');

  // -- Splice into template after the viewport tag --
  const pageHtml = templateHtml.replace(
    VIEWPORT_TAG,
    VIEWPORT_TAG + ogBlock
  );

  // -- Write to social/post/<id>/index.html --
  const outDir = path.join(postDir, id);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'index.html'), pageHtml, 'utf8');

  built++;
}

console.log(`built ${built} post pages`);
