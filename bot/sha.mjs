// Fingerprint of the bot logic. Must equal what the deployed function answers on ?sha (see README).
import * as R from './run.mjs';
import * as L from './live.mjs';
import crypto from 'node:crypto';
console.log(crypto.createHash('sha256').update([R, L].map((m) => Object.keys(m).sort().map((k) => String(m[k])).join('')).join('')).digest('hex'));
