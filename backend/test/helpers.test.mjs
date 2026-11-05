import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPoints, pickHistory } from '../src/index.js';

const NOW = Date.UTC(2026, 10, 6, 6, 0, 0);

test('cleanPoints keeps valid Bangladesh points and sorts them', () => {
  const pts = cleanPoints([
    { lat: 23.1, lng: 89.2, t: NOW - 1000, speed: 40 },
    { lat: 22.7, lng: 89.0, t: NOW - 5000 },
    { lat: 51.5, lng: -0.1, t: NOW },                 // London: rejected
    { lat: 23, lng: 89, t: NOW + 10 * 60_000 },        // future: rejected
    { lat: 23, lng: 89, t: NOW - 2 * 86400_000 },      // too old: rejected
    { lat: 23, lng: 89, t: NOW, accuracy: 500 },       // inaccurate: rejected
    { lat: 'x', lng: 89, t: NOW },                     // garbage: rejected
  ], NOW);
  assert.deepEqual(pts.map((p) => p.lat), [22.7, 23.1]);
  assert.equal(pts[0].speed, null);
});

test('pickHistory keeps at most one point per minute after the last stored one', () => {
  const pts = [0, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 132].map((s) => ({ t: NOW + s * 1000 }));
  assert.deepEqual(pickHistory(pts, NOW - 60_000).map((p) => (p.t - NOW) / 1000), [0, 60, 120]);
  assert.deepEqual(pickHistory(pts, NOW + 30_000).map((p) => (p.t - NOW) / 1000), [96]);
});
