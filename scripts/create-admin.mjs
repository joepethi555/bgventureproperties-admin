// Creates the first Super Admin user via wrangler d1.
// Usage: node scripts/create-admin.mjs <email> <password> <name> [--remote]
import { execSync } from 'node:child_process';
import { randomUUID, pbkdf2Sync } from 'node:crypto';

const [,, email, password, name = 'Administrator', flag = '--local'] = process.argv;
if (!email || !password) { console.error('Usage: node scripts/create-admin.mjs <email> <password> [name] [--remote]'); process.exit(1); }

const salt = randomUUID();
const hash = `pbkdf2$100000$${salt}$${pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex')}`;
const sql = `INSERT INTO users (email, password_hash, name, role) VALUES ('${email.toLowerCase().replace(/'/g, "''")}', '${hash}', '${name.replace(/'/g, "''")}', 'super_admin');`;

const remote = flag === '--remote' ? '--remote' : '--local';
execSync(`npx wrangler d1 execute bgv-admin ${remote} --command "${sql}"`, { stdio: 'inherit' });
console.log(`Super admin created: ${email}`);
