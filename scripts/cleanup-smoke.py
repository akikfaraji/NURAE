"""Clean smoke-test fixtures out of the dev DB (idempotent, column-introspecting)."""
import sqlite3

con = sqlite3.connect('/home/z/my-project/db/custom.db')
cur = con.cursor()

def cols(t):
    return [r[1] for r in cur.execute(f'PRAGMA table_info({t})').fetchall()]

def del_by(t, col, val):
    if col in cols(t):
        cur.execute(f'DELETE FROM {t} WHERE {col} = ?', (val,))

cur.execute("SELECT id, email FROM users WHERE email LIKE 'smoke%'")
rows = cur.fetchall()
print('smoke users:', rows)
for uid, _email in rows:
    if 'owner_id' in cols('bots'):
        cur.execute('SELECT id FROM bots WHERE owner_id = ?', (uid,))
    else:
        cur.execute('SELECT id FROM bots WHERE ownerId = ?', (uid,))
    bot_ids = [r[0] for r in cur.fetchall()]
    for bid in bot_ids:
        for t in ['conversations', 'bot_schedules', 'bot_broadcasts', 'bot_payments', 'logs']:
            for c in ('bot_id', 'botId'):
                del_by(t, c, bid)
    for t in ['bots']:
        for c in ('owner_id', 'ownerId'):
            del_by(t, c, uid)
    for t in ['agent_tokens', 'sessions', 'chat_entries', 'chat_sessions', 'user_files',
              'referrals', 'referral_rewards', 'entitlements', 'email_invites',
              'bot_user_states', 'topup_orders', 'ledger_entries', 'verification_tokens']:
        for c in ('ownerId', 'owner_id', 'userId', 'user_id'):
            del_by(t, c, uid)
    cur.execute('DELETE FROM users WHERE id = ?', (uid,))
con.commit()

print('after cleanup — smoke users:', cur.execute("SELECT email FROM users WHERE email LIKE 'smoke%'").fetchall())
print('smoke bots:', cur.execute("SELECT name FROM bots WHERE name LIKE '%Smoke%'").fetchall())
print('agent tokens:', cur.execute('SELECT name FROM agent_tokens').fetchall())
con.close()
