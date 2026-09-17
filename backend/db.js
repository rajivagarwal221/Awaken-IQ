// Single shared Prisma Client instance for the whole backend.
// PostgreSQL (Neon) is the only application datastore — see prisma/schema.prisma.
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

module.exports = prisma;
