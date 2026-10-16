/** SMTP credential check: auth-only (verify), no mail is sent. */
import nodemailer from 'nodemailer';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('/home/z/my-project/.env', 'utf8')
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '').trim()]),
);

const user = env.NURAE_GMAIL_USER;
const pass = env.NURAE_GMAIL_APP_PASSWORD;
console.log(`user: ${user ? user[0] + '***' + user.slice(-9) : 'MISSING'} · pass: ${pass ? pass.length + ' chars' : 'MISSING'}`);

const tx = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
try {
  await tx.verify();
  console.log('SMTP VERIFY: OK — Gmail accepted the credentials.');
} catch (err) {
  console.log('SMTP VERIFY: FAILED —', err.response || err.message);
}
