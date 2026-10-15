const Database = require('better-sqlite3');
const path = require('path');

const absolutePath = path.resolve(__dirname, 'db/custom.db');
console.log('Opening database:', absolutePath);

const db = new Database(absolutePath);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables found:', tables);

db.close();