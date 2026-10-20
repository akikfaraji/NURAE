import sqlite3, sys
p = sys.argv[1]
con = sqlite3.connect(p)
cur = con.cursor()
cols = [r[1] for r in cur.execute('PRAGMA table_info("users")')]
print("users cols:", cols)
