import sqlite3, sys
p = sys.argv[1]
con = sqlite3.connect(p)
cur = con.cursor()
tables = [r[0] for r in cur.execute("select name from sqlite_master where type='table' order by name")]
print("tables:", tables)
for t in tables:
    if 'verif' in t.lower() or 'code' in t.lower() or 'token' in t.lower():
        cols = [r[1] for r in cur.execute(f'PRAGMA table_info("{t}")')]
        print(t, cols)
        for row in cur.execute(f'select * from "{t}" order by rowid desc limit 3'):
            print("  ", row)
