// Seeds a fresh database with the minimum data the app needs to function:
// one admin account and the program catalog. Safe to re-run — every write
// is an upsert keyed on a unique field.
//
// Usage: npm run db:seed

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

const DEFAULT_ADMIN_NAME = process.env.ADMIN_NAME || 'Awaken IQ Admin';
const DEFAULT_ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@awakeniq.local';
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

const DEFAULT_PROGRAMS = [
  {
    slug: 'midbrain-development',
    title: 'Midbrain Development',
    description: 'A structured program to activate whole-brain learning through sensory and cognitive exercises.',
    durationText: '12 Weeks',
    ageGroup: '5-12 years',
    price: 1250.0,
    registrationFee: 150.0,
    gstPercentage: 18,
    materialsFee: 0,
    status: 'PUBLISHED',
  },
  {
    slug: 'dmit-assessment',
    title: 'DMIT Assessment',
    description: 'Dermatoglyphics Multiple Intelligence Test to identify innate learning strengths and potential.',
    durationText: '2 Sessions',
    ageGroup: 'All ages',
    price: 1250.0,
    registrationFee: 150.0,
    gstPercentage: 18,
    materialsFee: 0,
    status: 'PUBLISHED',
  },
  {
    slug: 'quantum-speed-reading',
    title: 'Quantum Speed Reading',
    description: 'Trains rapid information absorption and photographic memory techniques.',
    durationText: '8 Weeks',
    ageGroup: '8-16 years',
    price: 1250.0,
    registrationFee: 150.0,
    gstPercentage: 18,
    materialsFee: 0,
    status: 'PUBLISHED',
  },
];

async function main() {
  const passwordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 12);

  const admin = await prisma.admin.upsert({
    where: { email: DEFAULT_ADMIN_EMAIL },
    update: { role: 'ADMIN' },
    create: {
      name: DEFAULT_ADMIN_NAME,
      email: DEFAULT_ADMIN_EMAIL,
      passwordHash,
      role: 'ADMIN',
    },
  });
  console.log(`Admin ready: ${admin.email}`);

  const staffPassword = process.env.STAFF_PASSWORD || 'StaffPass123!';
  const staffPasswordHash = await bcrypt.hash(staffPassword, 12);
  const staff = await prisma.admin.upsert({
    where: { email: 'staff@awakeniq.local' },
    update: { role: 'STAFF' },
    create: {
      name: 'Awaken IQ Staff Member',
      email: 'staff@awakeniq.local',
      passwordHash: staffPasswordHash,
      role: 'STAFF',
    },
  });
  console.log(`Staff ready: ${staff.email}`);

  for (const program of DEFAULT_PROGRAMS) {
    const saved = await prisma.program.upsert({
      where: { slug: program.slug },
      update: program,
      create: program,
    });
    console.log(`Program ready: ${saved.title}`);
  }
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
