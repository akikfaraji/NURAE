const { createClient } = require('@libsql/client');
const path = require('path');

async function test() {
  const absolutePath = path.resolve(__dirname, 'db/custom.db');
  const url = `file:${absolutePath}`;
  console.log('Opening database with @libsql/client:', url);

  const client = createClient({ url });
  
  try {
    const result = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
    console.log('Tables found:', result.rows);
  } catch (e) {
    console.error('Query error:', e);
  } finally {
    await client.close();
  }
}

test();