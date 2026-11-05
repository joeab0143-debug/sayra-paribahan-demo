// Create a signed login token for a supervisor, counter or admin device.
// Needs the same TOKEN_SECRET the Worker uses (wrangler secret put TOKEN_SECRET).
//
//   TOKEN_SECRET=... node scripts/new-device.mjs <company_id> <supervisor|counter|admin> "<user name>" [days]
//   npx wrangler d1 execute bus-live --remote --command "<printed SQL>"
//
// To revoke a device later: UPDATE devices SET active = 0 WHERE id = '<device id>';  (takes effect within a minute)
import { randomBytes } from 'node:crypto';
import { signToken } from '../src/token.js';

const [companyId, role, userName = '', days = '180'] = process.argv.slice(2);
const secret = process.env.TOKEN_SECRET;
if (!companyId || !['supervisor', 'counter', 'admin'].includes(role) || !secret) {
  console.error('usage: TOKEN_SECRET=... node scripts/new-device.mjs <company_id> <supervisor|counter|admin> "<user name>" [days]');
  process.exit(1);
}
const id = 'dev_' + randomBytes(9).toString('base64url');
const exp = Date.now() + Number(days) * 86400_000;
const token = await signToken({ c: companyId, r: role, d: id, exp }, secret);
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
console.log('DEVICE:', id);
console.log('TOKEN (show once, store in the app):', token);
console.log(`SQL: INSERT INTO devices (id, company_id, role, user_name, active, created_at) VALUES (${q(id)}, ${q(companyId)}, ${q(role)}, ${q(userName)}, 1, ${Date.now()});`);
