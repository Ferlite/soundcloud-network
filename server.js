const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API = 'https://api-v2.soundcloud.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PUBLIC = path.join(__dirname, 'public');
const D3 = path.join(__dirname, 'node_modules', 'd3', 'dist', 'd3.min.js');

/* ---------- SoundCloud client_id (scraped from the public web app) ---------- */

let clientId = process.env.SOUNDCLOUD_CLIENT_ID || null;
let clientIdPromise = null;

async function scrapeClientId() {
  const html = await (await fetch('https://soundcloud.com/', { headers: { 'user-agent': UA } })).text();
  const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/[^"]*sndcdn\.com\/assets\/[^"]+\.js)"/g)].map(
    (m) => m[1]
  );
  for (const src of scripts.reverse()) {
    const js = await (await fetch(src, { headers: { 'user-agent': UA } })).text();
    const m = js.match(/client_id\s*[:=]\s*"([a-zA-Z0-9]{32})"/);
    if (m) return m[1];
  }
  throw new Error('Could not find a SoundCloud client_id');
}

function getClientId(refresh = false) {
  if (clientId && !refresh) return Promise.resolve(clientId);
  if (!clientIdPromise) {
    clientIdPromise = scrapeClientId()
      .then((id) => {
        clientId = id;
        console.log('Using SoundCloud client_id', id);
        return id;
      })
      .finally(() => (clientIdPromise = null));
  }
  return clientIdPromise;
}

/* ---------- Rate-limited API access ---------- */

const MAX_CONCURRENT = 6;
let active = 0;
const waiting = [];

// priority requests (things a person is waiting on, like a hover preview) jump the queue
async function limited(fn, priority = false) {
  if (active >= MAX_CONCURRENT) await new Promise((r) => (priority ? waiting.unshift(r) : waiting.push(r)));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiting.shift();
    if (next) next();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sc(url, priority = false) {
  return limited(async () => {
    let refreshed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const u = new URL(url);
      u.searchParams.set('client_id', await getClientId());
      const res = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' } });
      if ((res.status === 401 || res.status === 403) && !refreshed && !process.env.SOUNDCLOUD_CLIENT_ID) {
        refreshed = true;
        await getClientId(true);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        const err = new Error(`SoundCloud responded ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }
    const err = new Error('SoundCloud is rate limiting or unavailable');
    err.status = 503;
    throw err;
  }, priority);
}

/* ---------- Data helpers ---------- */

function slim(u) {
  return {
    id: u.id,
    username: u.permalink,
    name: u.username || u.permalink,
    fullName: u.full_name || '',
    avatar: (u.avatar_url || '').replace('http://', 'https://'),
    followers: u.followers_count || 0,
    followings: u.followings_count || 0,
    tracks: u.track_count || 0,
    city: u.city || '',
    country: u.country_code || '',
    description: (u.description || '').slice(0, 400),
    url: u.permalink_url,
    verified: !!u.verified,
  };
}

const cache = new Map();
const TTL = 60 * 60 * 1000;
const CACHE_MAX = Number(process.env.CACHE_MAX) || 2500; // entries kept in memory (free hosts have little)

async function cached(key, fn, ttl = TTL) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); // drop the oldest entry
  return value;
}

const getUser = (name) =>
  cached('user:' + name.toLowerCase(), async () => {
    const data = await sc(`${API}/resolve?url=${encodeURIComponent('https://soundcloud.com/' + name)}`);
    if (data.kind !== 'user') {
      const err = new Error('Not a user');
      err.status = 404;
      throw err;
    }
    return slim(data);
  });

async function fetchFollowings(id, limit) {
  const out = [];
  let url = `${API}/users/${id}/followings?limit=${Math.min(limit, 200)}`;
  while (url && out.length < limit) {
    const page = await sc(url);
    out.push(...page.collection);
    url = page.next_href;
  }
  return out.slice(0, limit);
}

const getFollowings = (id, limit) =>
  cached(`followings:${id}:${limit}`, async () => (await fetchFollowings(id, limit)).map(slim));

// SoundCloud's "fans also like" list for an artist (always the 10 closest, there's no paging)
const getRelated = (id) =>
  cached(`related:${id}`, async () => ((await sc(`${API}/users/${id}/relatedartists`)).collection || []).map(slim));

// The profiles an artist has chosen to feature on their page. Anywhere from none to several, so
// this follows paging rather than assuming a fixed size.
const getFeatured = (id) =>
  cached(`featured:${id}`, async () => {
    const out = [];
    let url = `${API}/users/${id}/featured-profiles?limit=50`;
    while (url && out.length < 200) {
      const page = await sc(url);
      out.push(...(page.collection || []));
      url = page.next_href;
    }
    return out.map(slim);
  });

// ids only: tiny to cache and send, used to look for follow-backs across the whole graph
const getFollowingIds = (id, limit) =>
  cached(`ids:${id}:${limit}`, async () => (await fetchFollowings(id, limit)).map((u) => u.id));

// SoundCloud-wide user search, for the search box's suggestions
const searchUsers = (q) =>
  cached(
    'search:' + q.toLowerCase(),
    async () => ((await sc(`${API}/search/users?q=${encodeURIComponent(q)}&limit=40`, true)).collection || []).map(slim),
    10 * 60 * 1000
  );

// A person's latest playable track, resolved to a direct mp3 stream the browser can play from.
// Stream links are signed and expire, so they're only cached for a short while.
const getTrack = (id) =>
  cached(
    'track:' + id,
    async () => {
      const page = await sc(`${API}/users/${id}/tracks?limit=20`, true);
      const newest = (t) => Date.parse(t.display_date || t.created_at) || 0;
      const track = (page.collection || [])
        .filter((t) => t.policy !== 'BLOCK' && t.media && t.media.transcodings)
        .sort((a, b) => newest(b) - newest(a))
        .find((t) => t.media.transcodings.some((c) => c.format.protocol === 'progressive'));
      if (!track) return null;
      const stream = track.media.transcodings.find((c) => c.format.protocol === 'progressive');
      const auth = track.track_authorization ? `?track_authorization=${encodeURIComponent(track.track_authorization)}` : '';
      const resolved = await sc(stream.url + auth, true);
      return {
        title: track.title,
        artwork: (track.artwork_url || '').replace('-large.', '-t200x200.') || null,
        url: resolved.url,
        duration: stream.duration || track.duration, // ms
        link: track.permalink_url,
      };
    },
    15 * 60 * 1000
  );

/* ---------- HTTP server ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------- Abuse protection (for when the site is public) ---------- */

// Every visitor's page load makes up to ~1500 API requests, and all of them go out to SoundCloud
// from this server's address. Without a limit, one person (or bot) could get that address blocked
// for everybody. Each visitor gets RATE_LIMIT API requests per 10 minutes (set RATE_LIMIT=0 to
// turn this off). Running locally is never limited.
const RATE_LIMIT = process.env.RATE_LIMIT === undefined ? 4000 : Number(process.env.RATE_LIMIT);
const RATE_WINDOW = 10 * 60 * 1000;
const visits = new Map(); // ip -> { count, resetAt }
setInterval(() => {
  const now = Date.now();
  for (const [ip, v] of visits) if (v.resetAt < now) visits.delete(ip);
}, 60 * 1000).unref();

function overLimit(req) {
  if (!RATE_LIMIT) return false;
  const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim(); // set by the host's proxy
  const ip = forwarded || req.socket.remoteAddress || '';
  if (!forwarded && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) return false;
  const now = Date.now();
  let v = visits.get(ip);
  if (!v || v.resetAt < now) visits.set(ip, (v = { count: 0, resetAt: now + RATE_WINDOW }));
  return ++v.count > RATE_LIMIT;
}

// a stray error should be logged, not take the whole site down
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let p;
    try {
      p = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400);
      return res.end('Bad request');
    }
    let m;

    if (p === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    if (p.startsWith('/api/') && overLimit(req)) {
      res.setHeader('retry-after', '600');
      return sendJson(res, 429, { error: 'Too many requests from your connection. Try again in a few minutes.' });
    }

    try {
      if (p === '/api/search') {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
        return sendJson(res, 200, q ? await searchUsers(q) : []);
      }
      if ((m = p.match(/^\/api\/user\/([\w-]+)$/))) {
        return sendJson(res, 200, await getUser(m[1]));
      }
      if ((m = p.match(/^\/api\/related\/(\d+)$/))) {
        return sendJson(res, 200, await getRelated(m[1]));
      }
      if ((m = p.match(/^\/api\/featured\/(\d+)$/))) {
        return sendJson(res, 200, await getFeatured(m[1]));
      }
      if ((m = p.match(/^\/api\/track\/(\d+)$/))) {
        return sendJson(res, 200, await getTrack(m[1]));
      }
      if ((m = p.match(/^\/api\/followings\/(\d+)$/))) {
        const limit = Math.max(1, Math.min(+url.searchParams.get('limit') || 50, 1000));
        const fetcher = url.searchParams.get('ids') ? getFollowingIds : getFollowings;
        return sendJson(res, 200, await fetcher(m[1], limit));
      }
    } catch (err) {
      const status = err.status || 500;
      return sendJson(res, status, { error: status === 404 ? 'User not found' : err.message });
    }

    if (p === '/vendor/d3.min.js') return sendFile(res, D3);

    const file = path.join(PUBLIC, p === '/' ? 'index.html' : p);
    if (file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(res, file);

    // /<soundcloud-name> serves the app
    if (/^\/[\w-]+\/?$/.test(p)) return sendFile(res, path.join(PUBLIC, 'index.html'));

    res.writeHead(404);
    res.end('Not found');
  })
  .listen(PORT, () => console.log(`SoundCloud network running at http://localhost:${PORT}/<soundcloud-name>`));
