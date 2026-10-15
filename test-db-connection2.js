const { PrismaClient } = require('@prisma/client');
const { PrismaLibSQL } = require('@prisma/adapter-libsql');
const path = require('path');

async function test() {
  // Test with absolute path
  const absolutePath = path.resolve(__dirname, 'db/custom.db');
  const url = `file:${absolutePath}`;
  console.log('Using absolute path URL:', url);
  
  const adapter = new PrismaLibSQL({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });
  const client = new PrismaClient({ adapter, log: ['error', 'warn'] });
  
  try {
    const result = await client.$queryRaw`SELECT name FROM sqlite_master WHERE type='table'`;
    console.log('Tables found:', result);
  } catch (e) {
    console.error('Query error:', e);
  } finally {
    await client.$disconnect();
  }
}

test();