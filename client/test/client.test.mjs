import test from 'node:test';
import assert from 'node:assert/strict';
import { createSender, distanceM } from '../location-sender.js';
import { createPoller } from '../live-poller.js';
import { projectOnRoute, speedEstimator, etaMinutes } from '../eta.js';

const mem = () => { let q = []; return { load: () => q, save: (x) => { q = x.slice(); }, get: () => q }; };

test('distanceM: Satkhira to Jashore is about 50 km in a straight line', () => {
  const d = distanceM({ lat: 22.7185, lng: 89.0705 }, { lat: 23.1664, lng: 89.2081 });
  assert.ok(d > 45_000 && d < 60_000, `got ${d}`);
});

test('sender: moving bus sends every 12 s, standing bus every 60 s', async () => {
  let t = 0; const sent = [];
  const s = createSender({ send: async (b) => { sent.push(...b); return true; }, store: mem(), now: () => t });
  assert.equal(await s.onPosition({ lat: 22.7, lng: 89.07, speed: 50, t }), 'sent');
  t = 5_000;  assert.equal(await s.onPosition({ lat: 22.701, lng: 89.07, speed: 50, t }), 'wait');
  t = 12_000; assert.equal(await s.onPosition({ lat: 22.702, lng: 89.07, speed: 50, t }), 'sent');
  // standing still now: 30 s later is too soon, 60 s later sends
  t = 42_000; assert.equal(await s.onPosition({ lat: 22.702, lng: 89.07, speed: 0, t }), 'wait');
  t = 72_000; assert.equal(await s.onPosition({ lat: 22.702, lng: 89.07, speed: 0, t }), 'sent');
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((p) => p.h), [1, 0, 1], 'one history point a minute');
});

test('sender: drops inaccurate fixes', async () => {
  const s = createSender({ send: async () => true, store: mem(), now: () => 0 });
  assert.equal(await s.onPosition({ lat: 22.7, lng: 89.07, accuracy: 400, t: 0 }), 'skip-accuracy');
});

test('sender: keeps points offline and sends them in order when back online', async () => {
  let t = 0, online = false; const got = []; const store = mem();
  const s = createSender({ send: async (b) => { if (!online) return false; got.push(...b); return true; }, store, now: () => t, maxBatch: 2 });
  for (let i = 0; i < 5; i++) { t = i * 12_000; await s.onPosition({ lat: 22.7 + i * 0.01, lng: 89.07, speed: 50, t }); }
  assert.equal(s.pending(), 5);
  assert.equal(store.get().length, 5, 'queue is persisted');
  online = true;
  assert.equal(await s.flush(), 'sent');
  assert.equal(s.pending(), 0);
  assert.deepEqual(got.map((p) => p.t), [0, 12_000, 24_000, 36_000, 48_000]);
});

test('poller: uses ETag, handles 304, backs off on errors', async () => {
  const timers = []; const calls = []; const data = [];
  const replies = [
    { status: 200, ok: true, headers: new Map([['etag', '"1-100"']]), json: async () => ({ trips: [1] }) },
    { status: 304, ok: false, headers: new Map(), json: async () => ({}) },
    'fail',
  ];
  const p = createPoller({
    url: 'x', token: 'T', onData: (d) => data.push(d),
    fetchImpl: async (_u, o) => { calls.push(o.headers['if-none-match'] || null); const r = replies.shift(); if (r === 'fail') throw new Error('net'); return { ...r, headers: { get: (k) => r.headers.get(k) } }; },
    setTimer: (fn, ms) => { timers.push(ms); return fn; }, clearTimer: () => {},
  });
  p.start(); await new Promise((r) => setImmediate(r));
  assert.deepEqual(data, [{ trips: [1] }]);
  assert.equal(timers[0], 15_000);
  p.refresh(); await new Promise((r) => setImmediate(r));
  assert.equal(calls[1], '"1-100"', 'second call sends the ETag');
  assert.equal(timers[1], 15_000, '304 keeps the normal interval');
  p.refresh(); await new Promise((r) => setImmediate(r));
  assert.equal(timers[2], 30_000, 'error doubles the wait');
  p.stop();
});

test('eta: projection, smoothing and minutes', () => {
  const route = [
    { id: 'stk', lat: 22.7185, lng: 89.0705, km: 0 },
    { id: 'jsr', lat: 23.1664, lng: 89.2081, km: 72 },
    { id: 'mgr', lat: 23.4873, lng: 89.4199, km: 118 },
  ];
  const mid = projectOnRoute(route, { lat: (22.7185 + 23.1664) / 2, lng: (89.0705 + 89.2081) / 2 });
  assert.ok(Math.abs(mid.km - 36) < 1, `got ${mid.km}`);
  assert.ok(mid.offRouteM < 50);
  const sp = speedEstimator();
  assert.equal(sp.get(), 45, 'fallback before any GPS speed');
  sp.push(0); sp.push(2); assert.equal(sp.get(), 45, 'standing still is ignored');
  sp.push(60); sp.push(60); assert.ok(sp.get() > 55 && sp.get() <= 60);
  assert.equal(sp.get() <= 80, true);
  assert.equal(etaMinutes(118 - mid.km, 60), 82);
  assert.equal(etaMinutes(-1, 60), 0);
});
