// End-to-end check against a running API (local `wrangler dev` or deployed).
//   node scripts/smoke.mjs <base_url> <supervisor_token> <counter_token> <other_company_counter_token> <trip_id> <other_trip_id>
// Optional, for the revocation/suspension checks (local only):
//   REVOKE_CMD / SUSPEND_CMD = shell commands that revoke the counter / suspend the other company
import { execSync } from 'node:child_process';

const [base, sup, cnt, other, trip, otherTrip] = process.argv.slice(2);
if (!otherTrip) { console.error('usage: see header'); process.exit(1); }
const H = (t) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
const post = (path, t, body) => fetch(base + path, { method: 'POST', headers: H(t), body: JSON.stringify(body) });
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) failed++; };

let r = await post('/api/trip-token', sup, { trip_id: otherTrip });
check("supervisor cannot get a token for another company's trip", r.status === 404);
r = await post('/api/trip-token', cnt, { trip_id: trip });
check('counter cannot get a trip token', r.status === 401);
r = await post('/api/trip-token', sup, { trip_id: trip });
const { token: tripTok } = await r.json();
check('supervisor gets a trip token', r.status === 200 && !!tripTok);

const now = Date.now();
const pts = [0, 12, 24, 36, 48, 60, 72].map((s, i) => ({ lat: 22.7185 + i * 0.002, lng: 89.0705, speed: 48, t: now - 72_000 + s * 1000, h: s % 60 === 0 ? 1 : 0 }));
r = await post('/api/loc', tripTok, { points: pts });
let j = await r.json();
check('trip token sends a batch', r.status === 200 && j.accepted === 7, JSON.stringify(j));
check('history: one row per marked minute', j.history_rows === 2, `rows=${j.history_rows}`);

r = await post('/api/loc', sup, { points: pts });
check('device token cannot post points directly', r.status === 401);
r = await post('/api/loc', tripTok.slice(0, -3) + 'abc', { points: pts });
check('tampered token rejected', r.status === 401);
r = await post('/api/loc', tripTok, { points: [{ lat: 51.5, lng: -0.1, t: now }] });
check('point outside Bangladesh rejected', r.status === 400);

r = await fetch(base + '/api/live', { headers: H(cnt) });
j = await r.json();
const etag = r.headers.get('etag');
check('counter sees own company bus', r.status === 200 && j.trips.length === 1 && j.trips[0].trip_id === trip);
check('latest point is the newest one', Math.abs(j.trips[0].lat - pts[6].lat) < 1e-9);
r = await fetch(base + '/api/live', { headers: { ...H(cnt), 'if-none-match': etag } });
check('unchanged data returns 304', r.status === 304);
r = await fetch(base + '/api/live', { headers: H(other) });
j = await r.json();
check("other company's counter sees none of these buses", r.status === 200 && j.trips.length === 0);

await post('/api/loc', tripTok, { points: [{ ...pts[0], t: now - 600_000 }] });
r = await fetch(base + '/api/track/' + encodeURIComponent(trip));
j = await r.json();
check('old point does not overwrite newer position; public track hides company', r.status === 200 && Math.abs(j.lat - pts[6].lat) < 1e-9 && !('company_id' in j));

r = await post('/api/loc/share', tripTok, { shared: false });
j = await r.json();
check('supervisor turns sharing off', r.status === 200 && j.updated === 1);

if (process.env.REVOKE_CMD && process.env.SUSPEND_CMD) {
  execSync(process.env.REVOKE_CMD, { stdio: 'ignore' });
  execSync(process.env.SUSPEND_CMD, { stdio: 'ignore' });
  console.log('… waiting 65 s for the per-minute revocation refresh');
  await new Promise((res) => setTimeout(res, 65_000));
  r = await fetch(base + '/api/live', { headers: H(cnt) });
  check('revoked counter is locked out within a minute', r.status === 401);
  r = await fetch(base + '/api/live', { headers: H(other) });
  check('suspended company is locked out within a minute', r.status === 401);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
