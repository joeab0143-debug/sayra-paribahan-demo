// Supervisor app: decides when to send GPS points, keeps them while offline,
// and sends them in batches. Works in a PWA, React Native or any JS runtime:
// you pass in `send` (network call) and `store` (persistence).
//
//   // once at trip start, with the supervisor's device token:
//   const { token: tripToken } = await fetch(API + '/api/trip-token', { method: 'POST',
//              headers: { authorization: 'Bearer ' + deviceToken, 'content-type': 'application/json' },
//              body: JSON.stringify({ trip_id: tripId }) }).then((r) => r.json());
//   const sender = createSender({
//     send: (points) => fetch(API + '/api/loc', { method: 'POST',
//              headers: { authorization: 'Bearer ' + tripToken, 'content-type': 'application/json' },
//              body: JSON.stringify({ points }) }).then((r) => r.ok),
//     store: { load: () => JSON.parse(localStorage.getItem('locq') || '[]'),
//              save: (q) => localStorage.setItem('locq', JSON.stringify(q)) },
//   });
//   navigator.geolocation.watchPosition((p) => sender.onPosition({
//     lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy,
//     speed: p.coords.speed == null ? null : p.coords.speed * 3.6, heading: p.coords.heading, t: p.timestamp }),
//     null, { enableHighAccuracy: true });

export function distanceM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function createSender({
  send,
  store = { load: () => [], save: () => {} },
  now = () => Date.now(),
  movingIntervalMs = 12_000,   // bus moving: one point every 12 s
  idleIntervalMs = 60_000,     // bus standing (ferry ghat, jam, counter): one point a minute
  minMoveM = 50,               // moved less than this and slower than 7 km/h = standing
  movingKmh = 7,
  maxAccuracyM = 100,
  maxBatch = 200,
  maxQueue = 2_000,            // about 6–7 hours of offline driving
  historyEveryMs = 60_000,     // mark one point a minute for the track history (h: 1)
}) {
  let queue = (store.load() || []).slice(-maxQueue);
  let lastSent = null;
  let lastSentAt = -Infinity;
  let lastHistT = -Infinity;
  let flushing = null;

  async function onPosition(p) {
    if (p.accuracy != null && p.accuracy > maxAccuracyM) return 'skip-accuracy';
    const moved = lastSent ? distanceM(lastSent, p) : Infinity;
    const moving = (p.speed ?? 0) >= movingKmh || moved >= minMoveM;
    const interval = moving ? movingIntervalMs : idleIntervalMs;
    if (now() - lastSentAt < interval) return 'wait';
    const t = p.t ?? now();
    const h = t - lastHistT >= historyEveryMs ? 1 : 0;
    if (h) lastHistT = t;
    queue.push({ lat: p.lat, lng: p.lng, speed: p.speed ?? null, heading: p.heading ?? null, accuracy: p.accuracy ?? null, t, h });
    if (queue.length > maxQueue) queue = queue.slice(-maxQueue);
    store.save(queue);
    lastSent = p;
    lastSentAt = now();
    return flush();
  }

  // One flush at a time; sends the oldest points first, in batches.
  function flush() {
    if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
    return flushing;
  }
  async function doFlush() {
    while (queue.length) {
      const batch = queue.slice(0, maxBatch);
      let ok = false;
      try { ok = await send(batch); } catch { ok = false; }
      if (!ok) return 'queued';
      queue = queue.slice(batch.length);
      store.save(queue);
    }
    return 'sent';
  }

  return { onPosition, flush, pending: () => queue.length };
}
