/**
 * NURAE — live Gmail SMTP delivery test (Task 15 diagnosis).
 *
 * Usage (credentials come from the environment, NEVER hardcoded):
 *   NURAE_GMAIL_USER=you@gmail.com NURAE_GMAIL_APP_PASSWORD=xxxx node scripts/test-smtp.js [to]
 *
 * Steps:
 *  1. Show which address dns.lookup returns BEFORE and AFTER the ipv4first fix.
 *  2. Send the exact verification template used by src/lib/nurae/auth/mailer.ts.
 *  3. Report success/failure with the raw SMTP error (if any).
 */

const dns = require('node:dns');
const nodemailer = require('nodemailer');

const user = process.env.NURAE_GMAIL_USER;
const pass = (process.env.NURAE_GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
const to = process.argv[2] || user;

if (!user || !pass) {
  console.error('FAIL: set NURAE_GMAIL_USER and NURAE_GMAIL_APP_PASSWORD in the environment.');
  process.exit(2);
}

function showAddresses(label) {
  return new Promise((resolve) => {
    dns.lookup('smtp.gmail.com', { all: true }, (err, addresses) => {
      if (err) return resolve(console.log(`${label}: lookup error ${err.message}`));
      const list = addresses.map((a) => `${a.address} (v${a.family})`).join(', ');
      console.log(`${label}: ${list}`);
      resolve();
    });
  });
}

(async () => {
  await showAddresses('DNS order BEFORE fix (verbatim)');
  dns.setDefaultResultOrder('ipv4first');
  await showAddresses('DNS order AFTER  fix (ipv4first)');

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  });

  console.log(`Sending test OTP mail  ${user} → ${to} …`);
  try {
    const info = await transport.sendMail({
      from: `"NURAE" <${user}>`,
      to,
      subject: `NURAE — your verification code: ${code}`,
      text: `Your verification code is:  ${code}\n\n(SMTP connectivity test from the NURAE codebase — code not valid anywhere.)`,
    });
    console.log(`OK — delivered. messageId=${info.messageId} response="${info.response}"`);
    console.log(`(code used in the subject line: ${code})`);
  } catch (err) {
    console.error(`FAIL — ${err.message}`);
    if (err.code) console.error(`code=${err.code}`);
    process.exit(1);
  }
})();
