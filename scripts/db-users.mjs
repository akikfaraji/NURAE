import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const users = await db.user.findMany({ select: { email: true, name: true }, take: 8 });
console.log(JSON.stringify(users));
await db.$disconnect();
