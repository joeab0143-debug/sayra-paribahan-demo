// End-to-end check against a running API (local `wrangler dev` or deployed).
//   node scripts/smoke.mjs <base_url> <supervisor_token> <counter_token> <other_company_counter_token> <trip_id> <other_trip_id>
const [base, sup, cnt, other, trip, otherTrip] = process.argv.slice(2);
if (!otherTrip) { console.error('usage: see header'); process.exit(1); }
const H = (t) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
const post = (path, t, body) => fetch(base + path, { method: 'POST', headers: H(t), body: JSON.stringify(body) });
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) failed++; };

const now = Date.now();
const pts = [0, 12, 24, 36, 48, 60, 72].map((s, i) => ({ lat: 22.7185 + i * 0.002, lng: 89.0705, speed: 48, t: now - 72_000 + s * 1000 }));

let r = await post('/api/loc', sup, { trip_id: trip, points: pts });
let j = await r.json();
check('supervisor sends a batch', r.status === 200 && j.accepted === 7, JSON.stringify(j));
check('history at most one row per minute', j.history_rows === 2, `rows=${j.history_rows}`);

r = await post('/api/loc', sup, { trip_id: otherTrip, points: pts });
check("supervisor cannot write another company's trip", r.status === 404);

r = await post('/api/loc', 'wrong-token', { trip_id: trip, points: pts });
check('bad token rejected', r.status === 401);

r = await post('/api/loc', sup, { trip_id: trip, points: [{ lat: 51.5, lng: -0.1, t: now }] });
check('point outside Bangladesh rejected', r.status === 400);

r = await fetch(base + '/api/live', { headers: H(cnt) });
j = await r.json();
const etag = r.headers.get('etag');
check('counter sees own company bus', r.status === 200 && j.trips.length === 1 && j.trips[0].trip_id === trip, JSON.stringify(j.trips[0] || {}));
check('latest point is the newest one', Math.abs(j.trips[0].lat - pts[6].lat) < 1e-9);

r = await fetch(base + '/api/live', { headers: { ...H(cnt), 'if-none-match': etag } });
check('unchanged data returns 304', r.status === 304);

r = await fetch(base + '/api/live', { headers: H(other) });
j = await r.json();
check("other company's counter sees none of these buses", r.status === 200 && j.trips.length === 0, JSON.stringify(j));

r = await fetch(base + '/api/live', { headers: H(sup).authorization ? { authorization: 'Bearer nope' } : {} });
check('live without valid token rejected', r.status === 401);

r = await post('/api/loc', sup, { trip_id: trip, points: [{ ...pts[0], t: now - 600_000 }] });
r = await fetch(base + '/api/track/' + encodeURIComponent(trip));
j = await r.json();
check('old point does not overwrite newer position (public track)', r.status === 200 && Math.abs(j.lat - pts[6].lat) < 1e-9, JSON.stringify(j));

r = await post('/api/loc/share', sup, { trip_id: trip, shared: false });
j = await r.json();
check('supervisor turns sharing off', r.status === 200 && j.updated === 1);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
