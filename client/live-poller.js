// Counter / admin screen: asks the server for its company's bus positions every 15 s.
// Sends the last ETag so unchanged data comes back as an empty 304, pauses while the
// screen is hidden, and backs off when the network fails.
//
//   const poller = createPoller({ url: API + '/api/live', token, onData: (d) => drawBuses(d.trips),
//     isVisible: () => document.visibilityState === 'visible' });
//   poller.start();

export function createPoller({
  url,
  token,
  onData,
  onError = () => {},
  fetchImpl = (...a) => fetch(...a),
  intervalMs = 15_000,
  maxBackoffMs = 120_000,
  isVisible = () => true,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
}) {
  let etag = null, timer = null, fails = 0, running = false;

  function schedule(ms) { if (running) timer = setTimer(tick, ms); }

  async function tick() {
    if (!running) return;
    if (!isVisible()) return schedule(intervalMs);
    try {
      const headers = { authorization: `Bearer ${token}` };
      if (etag) headers['if-none-match'] = etag;
      const res = await fetchImpl(url, { headers });
      if (res.status === 304) {
        fails = 0;
      } else if (res.ok) {
        etag = res.headers.get('etag');
        fails = 0;
        onData(await res.json());
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      fails++;
      onError(err);
    }
    schedule(fails ? Math.min(maxBackoffMs, intervalMs * 2 ** fails) : intervalMs);
  }

  return {
    start() { if (running) return; running = true; tick(); },
    stop() { running = false; clearTimer(timer); },
    refresh() { clearTimer(timer); tick(); },
  };
}
