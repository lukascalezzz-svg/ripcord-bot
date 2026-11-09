// Makes the owner code for the dashboard's live controls. node bot/admin-code.mjs
// The code is written to .admin-code (git-ignored, never printed); only its sha256 goes to the database.
import fs from 'node:fs';
import crypto from 'node:crypto';

const file = new URL('../.admin-code', import.meta.url);
const code = crypto.randomBytes(15).toString('base64url'); // 20 characters, 120 bits
fs.writeFileSync(file, code + '\n', { mode: 0o600 });
const hash = crypto.createHash('sha256').update(code).digest('hex');
console.log(`code saved to ${file.pathname}`);
console.log(`run in Supabase SQL editor:\nupdate rc_private set admin_hash = '${hash}' where id = 1;`);
