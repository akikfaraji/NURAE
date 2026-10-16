import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('/home/z/my-project/.env','utf8').split(/\r?\n/).map(l=>l.match(/^([A-Za-z_]\w*)\s*=\s*(.*)$/)).filter(Boolean).map(m=>[m[1],m[2]]));
const url = env.DATABASE_URL || 'file:/home/z/my-project/db/custom.db';
const db = createClient({ url: url.startsWith('file:') && !url.includes(':memory:') ? url.replace(/^file:/, 'file:') : url });
const bots = await db.execute("SELECT name, provider, model, status, substr(system_prompt,1,60) AS sp FROM bots WHERE name LIKE '%Slice%' OR name LIKE '%test%' ORDER BY created_at DESC LIMIT 5");
console.log('BOTS:'); for (const r of bots.rows) console.log(' -', JSON.stringify(r));
const steps = await db.execute("SELECT seq, tool, status, substr(label,1,90) AS label FROM agent_steps ORDER BY created_at DESC LIMIT 12");
console.log('AGENT STEPS (latest):'); for (const r of steps.rows) console.log(' -', JSON.stringify(r));
