// Create a login token for a supervisor, counter or admin device.
// Prints the token (give it to the user's app once) and the SQL to store its hash.
//
//   node scripts/new-device.mjs <company_id> <supervisor|counter|admin> "<user name>"
//   npx wrangler d1 execute bus-live --remote --command "<printed SQL>"
import { randomBytes, createHash } from 'node:crypto';

const [companyId, role, userName = ''] = process.argv.slice(2);
if (!companyId || !['supervisor', 'counter', 'admin'].includes(role)) {
  console.error('usage: node scripts/new-device.mjs <company_id> <supervisor|counter|admin> "<user name>"');
  process.exit(1);
}
const token = randomBytes(24).toString('base64url');
const hash = createHash('sha256').update(token).digest('hex');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
console.log('TOKEN (show once, store in the app):', token);
console.log(
  `SQL: INSERT INTO devices (token_hash, company_id, role, user_name, active, created_at) VALUES (${q(hash)}, ${q(companyId)}, ${q(role)}, ${q(userName)}, 1, ${Date.now()});`
);
