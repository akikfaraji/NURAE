"""Read-only probe of the NURAE dev database: tables, row counts, columns."""
import os
import sqlite3

p = os.path.expandvars(r"%LOCALAPPDATA%\FRAZIYM\NURAE\db\custom.db")
print("db:", p, "exists:", os.path.exists(p))
con = sqlite3.connect(p)
cur = con.cursor()
rows = cur.execute("select name from sqlite_master where type='table' order by name").fetchall()
for (name,) in rows:
    cols = [r[1] for r in cur.execute(f'PRAGMA table_info("{name}")')]
    n = cur.execute(f'select count(*) from "{name}"').fetchone()[0]
    print(f"{name} rows={n} cols={cols}")
