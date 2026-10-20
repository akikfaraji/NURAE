import sqlite3, sys
p = sys.argv[1]
con = sqlite3.connect(p)
cur = con.cursor()
cur.execute("UPDATE users SET email_verified=1 WHERE email=?", ("vera4@example.com",))
con.commit()
print("updated:", cur.rowcount)
