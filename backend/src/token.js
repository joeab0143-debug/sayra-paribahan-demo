// Signed tokens: "v1.<payload>.<signature>", both parts base64url.
// payload = { c: company_id, r: role, d: device_id, t?: trip_id, exp: ms }
// Verifying needs only the secret, not the database.

const enc = new TextEncoder();
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

const keyCache = new Map();
async function hmacKey(secret) {
  if (!secret || secret.length < 32) throw new Error('TOKEN_SECRET must be at least 32 characters');
  if (!keyCache.has(secret)) {
    keyCache.set(secret, crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  }
  return keyCache.get(secret);
}

export async function signToken(payload, secret) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode('v1.' + body)));
  return `v1.${body}.${b64u(sig)}`;
}

// Returns the payload, or null if the token is malformed, forged or expired.
export async function verifyToken(token, secret, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64u(parts[2]), enc.encode('v1.' + parts[1]));
  } catch { return null; }
  if (!ok) return null;
  let p;
  try { p = JSON.parse(new TextDecoder().decode(unb64u(parts[1]))); } catch { return null; }
  if (!p || typeof p.c !== 'string' || typeof p.r !== 'string' || typeof p.d !== 'string') return null;
  if (!Number.isFinite(p.exp) || p.exp < now) return null;
  return p;
}
