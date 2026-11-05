// Live bus location API — Cloudflare Worker + D1, polling design, built for 1,000+ buses.
//
//   POST /api/trip-token   supervisor device token -> short-lived token for one trip (1 DB read, once per trip)
//   POST /api/loc          trip token: one or more GPS points            (1 DB batch, no other reads)
//   POST /api/loc/share    trip token: location sharing on/off
//   GET  /api/live         counter/admin device token: company's buses    (served from cache most of the time)
//   GET  /api/track/:trip  public: one trip's position (passenger tracking page)
//   scheduled()            daily clean-up of old history and finished trips
//
// Why it stays fast: a D1 database runs one query at a time, so every query saved per ping matters.
//   * tokens are HMAC-signed and carry company/role/device/trip, so auth needs no DB lookup;
//   * suspended companies and revoked devices are read once a minute per Worker instance;
//   * the app marks which points go to history (one a minute), so the server needs no extra read.

import { signToken, verifyToken } from './token.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type,if-none-match',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-expose-headers': 'etag',
};

// Bangladesh, with some margin. Points outside are rejected as GPS noise.
const BOUNDS = { minLat: 20.3, maxLat: 26.8, minLng: 87.9, maxLng: 92.8 };
const MAX_POINTS_PER_REQUEST = 500;
const MAX_ACCURACY_M = 100;
const HISTORY_MIN_GAP_MS = 55_000;      // the app marks one point a minute; server enforces a floor
const LIVE_WINDOW_MS = 6 * 3600_000;
const TRIP_TOKEN_MS = 20 * 3600_000;
const META_TTL_MS = 60_000;

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });

// ---- suspended companies / revoked devices, cached per Worker instance -------------------
let META = { at: 0, suspended: new Set(), revoked: new Set() };
export function _resetMeta() { META = { at: 0, suspended: new Set(), revoked: new Set() }; }
async function meta(env) {
  if (Date.now() - META.at < META_TTL_MS) return META;
  const [c, d] = await env.DB.batch([
    env.DB.prepare("SELECT id FROM companies WHERE status <> 'active'"),
    env.DB.prepare('SELECT id FROM devices WHERE active = 0'),
  ]);
  META = { at: Date.now(), suspended: new Set(c.results.map((r) => r.id)), revoked: new Set(d.results.map((r) => r.id)) };
  return META;
}

async function authenticate(req, env, roles) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const p = await verifyToken(m[1], env.TOKEN_SECRET);
  if (!p || !roles.includes(p.r)) return null;
  const { suspended, revoked } = await meta(env);
  if (suspended.has(p.c) || revoked.has(p.d)) return null;
  return p;
}

// ---- input checks -----------------------------------------------------------------------
export function cleanPoints(raw, now = Date.now()) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw) {
    const lat = Number(p?.lat), lng = Number(p?.lng), t = Number(p?.t);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(t)) continue;
    if (lat < BOUNDS.minLat || lat > BOUNDS.maxLat || lng < BOUNDS.minLng || lng > BOUNDS.maxLng) continue;
    if (t > now + 120_000 || t < now - 24 * 3600_000) continue;
    if (p.accuracy != null && Number(p.accuracy) > MAX_ACCURACY_M) continue;
    const speed = p.speed == null ? null : Math.max(0, Math.min(150, Number(p.speed) || 0));
    const heading = p.heading == null ? null : ((Number(p.heading) % 360) + 360) % 360;
    out.push({ lat, lng, t, speed, heading, h: p.h ? 1 : 0 });
  }
  out.sort((a, b) => a.t - b.t);
  return out.slice(-MAX_POINTS_PER_REQUEST);
}

// History rows: only points the app marked, and never closer than HISTORY_MIN_GAP_MS.
export function pickHistory(points) {
  const picked = [];
  let last = -Infinity;
  for (const p of points) {
    if (p.h && p.t - last >= HISTORY_MIN_GAP_MS) { picked.push(p); last = p.t; }
  }
  return picked;
}

// ---- handlers ---------------------------------------------------------------------------
async function postTripToken(req, env) {
  const who = await authenticate(req, env, ['supervisor']);
  if (!who) return json({ error: 'unauthorized' }, 401);
  const body = await req.json().catch(() => null);
  const tripId = String(body?.trip_id || '');
  const trip = tripId && (await env.DB.prepare('SELECT company_id FROM trips WHERE id = ?1').bind(tripId).first());
  if (!trip || trip.company_id !== who.c) return json({ error: 'trip not found' }, 404);
  const exp = Date.now() + TRIP_TOKEN_MS;
  const token = await signToken({ c: who.c, r: 'trip', d: who.d, t: tripId, exp }, env.TOKEN_SECRET);
  return json({ token, exp });
}

async function postLocation(req, env) {
  const who = await authenticate(req, env, ['trip']);
  if (!who) return json({ error: 'unauthorized' }, 401);
  const body = await req.json().catch(() => null);
  const points = cleanPoints(body?.points);
  if (!points.length) return json({ error: 'at least one valid point is required' }, 400);
  const last = points[points.length - 1];
  const hist = pickHistory(points);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO live_positions (trip_id, company_id, lat, lng, speed, heading, recorded_at, received_at, shared)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)
       ON CONFLICT(trip_id) DO UPDATE SET
         lat = excluded.lat, lng = excluded.lng, speed = excluded.speed, heading = excluded.heading,
         recorded_at = excluded.recorded_at, received_at = excluded.received_at, shared = 1
       WHERE excluded.recorded_at >= live_positions.recorded_at`
    ).bind(who.t, who.c, last.lat, last.lng, last.speed, last.heading, last.t, now),
    ...hist.map((p) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO position_history (trip_id, company_id, lat, lng, speed, recorded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      ).bind(who.t, who.c, p.lat, p.lng, p.speed, p.t)
    ),
  ]);
  return json({ ok: true, accepted: points.length, history_rows: hist.length });
}

async function postShare(req, env) {
  const who = await authenticate(req, env, ['trip']);
  if (!who) return json({ error: 'unauthorized' }, 401);
  const body = await req.json().catch(() => null);
  const res = await env.DB.prepare('UPDATE live_positions SET shared = ?1 WHERE trip_id = ?2 AND company_id = ?3')
    .bind(body?.shared ? 1 : 0, who.t, who.c).run();
  return json({ ok: true, updated: res.meta?.changes ?? 0 });
}

async function cached(req, ctx, cacheKey, seconds, produce) {
  const cache = caches.default;
  const key = new Request(cacheKey);
  let res = await cache.match(key);
  if (!res) {
    res = await produce();
    if (res.status === 200) {
      const copy = new Response(res.body, res);
      copy.headers.set('cache-control', `public, max-age=${seconds}`);
      ctx.waitUntil(cache.put(key, copy.clone()));
      res = copy;
    }
  }
  const etag = res.headers.get('etag');
  if (etag && req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag, ...CORS } });
  }
  return res;
}

async function getLive(req, env, ctx) {
  const who = await authenticate(req, env, ['counter', 'admin', 'supervisor']);
  if (!who) return json({ error: 'unauthorized' }, 401);
  const seconds = Number(env.LIVE_CACHE_SECONDS || 5);
  // The cache key uses the company from the signed token, never from the URL.
  return cached(req, ctx, `https://cache.internal/live/${encodeURIComponent(who.c)}`, seconds, async () => {
    const { results } = await env.DB.prepare(
      `SELECT trip_id, lat, lng, speed, heading, recorded_at, received_at, shared
         FROM live_positions WHERE company_id = ?1 AND received_at > ?2`
    ).bind(who.c, Date.now() - LIVE_WINDOW_MS).all();
    const etag = `"${results.length}-${Math.max(0, ...results.map((r) => r.received_at))}"`;
    return json({ now: Date.now(), trips: results }, 200, { etag });
  });
}

async function getTrack(req, env, ctx, tripId) {
  const seconds = Number(env.TRACK_CACHE_SECONDS || 10);
  return cached(req, ctx, `https://cache.internal/track/${encodeURIComponent(tripId)}`, seconds, async () => {
    const row = await env.DB.prepare(
      'SELECT trip_id, company_id, lat, lng, speed, recorded_at, shared FROM live_positions WHERE trip_id = ?1'
    ).bind(tripId).first();
    if (!row || (await meta(env)).suspended.has(row.company_id)) return json({ error: 'no position yet' }, 404);
    const { company_id, ...pub } = row;
    return json(pub, 200, { etag: `"${row.recorded_at}"` });
  });
}

export async function cleanup(env, now = Date.now()) {
  const days = Number(env.HISTORY_DAYS || 45);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM position_history WHERE recorded_at < ?1').bind(now - days * 86400_000),
    env.DB.prepare('DELETE FROM live_positions WHERE received_at < ?1').bind(now - 24 * 3600_000),
  ]);
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    try {
      if (req.method === 'POST' && url.pathname === '/api/trip-token') return await postTripToken(req, env);
      if (req.method === 'POST' && url.pathname === '/api/loc') return await postLocation(req, env);
      if (req.method === 'POST' && url.pathname === '/api/loc/share') return await postShare(req, env);
      if (req.method === 'GET' && url.pathname === '/api/live') return await getLive(req, env, ctx);
      const m = url.pathname.match(/^\/api\/track\/([^/]+)$/);
      if (req.method === 'GET' && m) return await getTrack(req, env, ctx, decodeURIComponent(m[1]));
      return json({ error: 'not found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'server error' }, 500);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
};
