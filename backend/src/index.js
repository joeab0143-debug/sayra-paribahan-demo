// Live bus location API — Cloudflare Worker + D1, polling design.
//
//   POST /api/loc          supervisor app sends one or more GPS points for its trip
//   POST /api/loc/share    supervisor turns location sharing on/off
//   GET  /api/live         counters/admins poll every 15 s for their company's buses
//   GET  /api/track/:trip  public: one trip's position (passenger tracking page)
//   scheduled()            daily clean-up of old history and finished trips
//
// Cost notes (see README):
//   * a ping = 1 row written (latest position). History is written at most once a minute.
//   * /api/live answers from the Workers cache for LIVE_CACHE_SECONDS, so many counters
//     polling the same company share one D1 read, and ETag lets unchanged data return 304.

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
const HISTORY_EVERY_MS = 60_000;
const LIVE_WINDOW_MS = 6 * 3600_000;

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });

export async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function authenticate(req, env, roles) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const row = await env.DB.prepare(
    `SELECT d.company_id, d.role, d.user_name
       FROM devices d JOIN companies c ON c.id = d.company_id
      WHERE d.token_hash = ?1 AND d.active = 1 AND c.status = 'active'`
  ).bind(await sha256hex(m[1])).first();
  return row && roles.includes(row.role) ? row : null;
}

// Keep only plausible points; normalise field names.
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
    out.push({ lat, lng, t, speed, heading });
  }
  out.sort((a, b) => a.t - b.t);
  return out.slice(-MAX_POINTS_PER_REQUEST);
}

// From a sorted batch, pick points that are at least HISTORY_EVERY_MS apart,
// starting after the last history time already stored.
export function pickHistory(points, lastHistAt) {
  const picked = [];
  let last = lastHistAt || 0;
  for (const p of points) {
    if (p.t - last >= HISTORY_EVERY_MS) {
      picked.push(p);
      last = p.t;
    }
  }
  return picked;
}

async function postLocation(req, env) {
  const who = await authenticate(req, env, ['supervisor']);
  if (!who) return json({ error: 'unauthorized' }, 401);
  const body = await req.json().catch(() => null);
  const tripId = String(body?.trip_id || '');
  const points = cleanPoints(body?.points);
  if (!tripId || !points.length) return json({ error: 'trip_id and at least one valid point are required' }, 400);

  const trip = await env.DB.prepare('SELECT company_id FROM trips WHERE id = ?1').bind(tripId).first();
  if (!trip || trip.company_id !== who.company_id) return json({ error: 'trip not found' }, 404);

  const prev = await env.DB.prepare('SELECT hist_at FROM live_positions WHERE trip_id = ?1').bind(tripId).first();
  const now = Date.now();
  const last = points[points.length - 1];
  const hist = pickHistory(points, prev?.hist_at || 0);

  const stmts = [
    env.DB.prepare(
      `INSERT INTO live_positions (trip_id, company_id, lat, lng, speed, heading, recorded_at, received_at, hist_at, shared)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1)
       ON CONFLICT(trip_id) DO UPDATE SET
         lat = excluded.lat, lng = excluded.lng, speed = excluded.speed, heading = excluded.heading,
         recorded_at = excluded.recorded_at, received_at = excluded.received_at, shared = 1,
         hist_at = MAX(live_positions.hist_at, excluded.hist_at)
       WHERE excluded.recorded_at >= live_positions.recorded_at`
    ).bind(tripId, who.company_id, last.lat, last.lng, last.speed, last.heading, last.t, now,
           hist.length ? hist[hist.length - 1].t : (prev?.hist_at || 0)),
    ...hist.map((p) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO position_history (trip_id, company_id, lat, lng, speed, recorded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      ).bind(tripId, who.company_id, p.lat, p.lng, p.speed, p.t)
    ),
  ];
  await env.DB.batch(stmts);
  return json({ ok: true, accepted: points.length, history_rows: hist.length });
}

async function postShare(req, env) {
  const who = await authenticate(req, env, ['supervisor']);
  if (!who) return json({ error: 'unauthorized' }, 401);
  const body = await req.json().catch(() => null);
  const tripId = String(body?.trip_id || '');
  const res = await env.DB.prepare('UPDATE live_positions SET shared = ?1 WHERE trip_id = ?2 AND company_id = ?3')
    .bind(body?.shared ? 1 : 0, tripId, who.company_id).run();
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
  // The cache key includes the company from the token, never from the URL.
  return cached(req, ctx, `https://cache.internal/live/${encodeURIComponent(who.company_id)}`, seconds, async () => {
    const { results } = await env.DB.prepare(
      `SELECT trip_id, lat, lng, speed, heading, recorded_at, received_at, shared
         FROM live_positions WHERE company_id = ?1 AND received_at > ?2`
    ).bind(who.company_id, Date.now() - LIVE_WINDOW_MS).all();
    const etag = `"${results.length}-${Math.max(0, ...results.map((r) => r.received_at))}"`;
    return json({ now: Date.now(), trips: results }, 200, { etag });
  });
}

async function getTrack(req, env, ctx, tripId) {
  const seconds = Number(env.TRACK_CACHE_SECONDS || 10);
  return cached(req, ctx, `https://cache.internal/track/${encodeURIComponent(tripId)}`, seconds, async () => {
    const row = await env.DB.prepare(
      `SELECT l.trip_id, l.lat, l.lng, l.speed, l.recorded_at, l.shared
         FROM live_positions l JOIN companies c ON c.id = l.company_id
        WHERE l.trip_id = ?1 AND c.status = 'active'`
    ).bind(tripId).first();
    if (!row) return json({ error: 'no position yet' }, 404);
    return json(row, 200, { etag: `"${row.recorded_at}"` });
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
