import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPoints, pickHistory } from '../src/index.js';
import { signToken, verifyToken } from '../src/token.js';

const NOW = Date.UTC(2026, 10, 6, 6, 0, 0);
const SECRET = 'test-secret-test-secret-test-secret-1234';

test('cleanPoints keeps valid Bangladesh points and sorts them', () => {
  const pts = cleanPoints([
    { lat: 23.1, lng: 89.2, t: NOW - 1000, speed: 40, h: 1 },
    { lat: 22.7, lng: 89.0, t: NOW - 5000 },
    { lat: 51.5, lng: -0.1, t: NOW },                 // London: rejected
    { lat: 23, lng: 89, t: NOW + 10 * 60_000 },        // future: rejected
    { lat: 23, lng: 89, t: NOW - 2 * 86400_000 },      // too old: rejected
    { lat: 23, lng: 89, t: NOW, accuracy: 500 },       // inaccurate: rejected
    { lat: 'x', lng: 89, t: NOW },                     // garbage: rejected
  ], NOW);
  assert.deepEqual(pts.map((p) => p.lat), [22.7, 23.1]);
  assert.deepEqual(pts.map((p) => p.h), [0, 1]);
  assert.equal(pts[0].speed, null);
});

test('pickHistory keeps only marked points, never closer than 55 s', () => {
  const pts = [0, 12, 24, 30, 60, 72, 120].map((s) => ({ t: NOW + s * 1000, h: [0, 30, 60, 120].includes(s) ? 1 : 0 }));
  assert.deepEqual(pickHistory(pts).map((p) => (p.t - NOW) / 1000), [0, 60, 120]);
});

test('signed tokens: valid, forged, expired, wrong secret', async () => {
  const tok = await signToken({ c: 'sayra', r: 'counter', d: 'dev_1', exp: NOW + 1000 }, SECRET);
  assert.deepEqual(await verifyToken(tok, SECRET, NOW), { c: 'sayra', r: 'counter', d: 'dev_1', exp: NOW + 1000 });
  assert.equal(await verifyToken(tok, SECRET, NOW + 2000), null, 'expired');
  assert.equal(await verifyToken(tok, SECRET.replace('1', '2'), NOW), null, 'wrong secret');
  const [v, , sig] = tok.split('.');
  const forged = `${v}.${btoa(JSON.stringify({ c: 'nk', r: 'admin', d: 'x', exp: NOW + 1e9 })).replace(/=+$/, '')}.${sig}`;
  assert.equal(await verifyToken(forged, SECRET, NOW), null, 'changed payload');
  assert.equal(await verifyToken('garbage', SECRET, NOW), null);
});
