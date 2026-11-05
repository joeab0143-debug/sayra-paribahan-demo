// Arrival-time estimate without any paid routing API.
// Stops are known in advance (company admin places each counter on the map once),
// with their road distance from the start of the route in km.
//
//   const route = [{ id: 'snr', lat: 22.33, lng: 89.10, km: 0 }, { id: 'klg', lat: 22.45, lng: 89.04, km: 24 }, ...];
//   const at = projectOnRoute(route, { lat, lng });          // { km, offRouteM, segment }
//   speed.push(gpsKmh);                                       // keep a smoothed speed per trip
//   etaMinutes(stopKm - at.km, speed.get());

const toXY = (p, lat0) => {
  const R = 6371000, rad = Math.PI / 180;
  return { x: p.lng * rad * R * Math.cos(lat0 * rad), y: p.lat * rad * R };
};

// Nearest point on the stop-to-stop polyline; road km is interpolated between stops.
export function projectOnRoute(stops, p) {
  if (!stops || stops.length < 2) throw new Error('route needs at least two stops');
  const lat0 = p.lat;
  const P = toXY(p, lat0);
  let best = null;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = toXY(stops[i], lat0), b = toXY(stops[i + 1], lat0);
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const f = len2 ? Math.max(0, Math.min(1, ((P.x - a.x) * dx + (P.y - a.y) * dy) / len2)) : 0;
    const qx = a.x + f * dx, qy = a.y + f * dy;
    const d = Math.hypot(P.x - qx, P.y - qy);
    if (!best || d < best.offRouteM) {
      best = { km: stops[i].km + f * (stops[i + 1].km - stops[i].km), offRouteM: d, segment: i };
    }
  }
  return best;
}

// Smoothed speed: ignores standing still (ferry queue, jam) so one stop does not
// make the estimate explode, and clamps to a sensible highway range.
export function speedEstimator({ alpha = 0.25, minKmh = 15, maxKmh = 80, fallbackKmh = 45, standingKmh = 5 } = {}) {
  let v = null;
  return {
    push(kmh) {
      if (kmh == null || !Number.isFinite(kmh) || kmh < standingKmh) return;
      v = v == null ? kmh : alpha * kmh + (1 - alpha) * v;
    },
    get() { return Math.max(minKmh, Math.min(maxKmh, v ?? fallbackKmh)); },
  };
}

export function etaMinutes(remainingKm, kmh, extraWaitMin = 0) {
  if (remainingKm <= 0) return 0;
  return Math.round((remainingKm / kmh) * 60 + extraWaitMin);
}
