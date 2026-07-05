import 'dotenv/config';
import { PrismaClient, Criticality } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_RULES = [
  {
    title: 'Secret Exposure',
    description:
      'A hardcoded secret, token, password, or private key was added directly in source code. ' +
      'Secrets must be read from environment variables or a secrets manager. ' +
      'Bad: `const apiKey = "sk-abc123"`. Good: `const apiKey = process.env.API_KEY`.',
    criticality: Criticality.high,
    isDefault: true,
  },
  {
    title: 'SQL Injection Risk',
    description:
      'User-controlled input is concatenated directly into a raw SQL query without parameterization. ' +
      'Use parameterized queries or the ORM query builder instead. ' +
      'Bad: `"SELECT * FROM users WHERE id = " + userId`. ' +
      'Good: `db.query("SELECT * FROM users WHERE id = ?", [userId])`.',
    criticality: Criticality.high,
    isDefault: true,
  },
  {
    title: 'Duplicated Database Query',
    description:
      'A database query was added that duplicates an existing model method or performs the same lookup already ' +
      'present elsewhere in the codebase. Reuse or extend the existing method instead of adding a new ad hoc query. ' +
      'Report only when the duplication is visible within the diff or its immediate context.',
    criticality: Criticality.medium,
    isDefault: true,
    fileGlobs: ['**/*.php', '**/*.py', '**/*.ts'],
  },
  {
    title: 'N+1 Query Pattern',
    description:
      'A database query is executed inside a loop, causing one query per iteration instead of a single batched query. ' +
      'Bad: `for (const id of ids) { await db.find(id) }`. ' +
      'Good: `await db.findMany({ where: { id: { in: ids } } })`.',
    criticality: Criticality.medium,
    isDefault: true,
    fileGlobs: ['**/*.php', '**/*.py', '**/*.ts'],
  },
  {
    title: 'Magic Number Without Named Constant',
    description:
      'A literal number or string with unclear business meaning (a status code, threshold, limit, or identifier) was ' +
      'introduced directly in a conditional or calculation instead of being extracted into a named constant. ' +
      'Report only when the literal is genuinely unclear in context, not for obvious values like 0, 1, or -1 used as ' +
      'counters or array indices. ' +
      'Bad: `if (status === 3) { ... }`. Good: `if (status === Status.APPROVED) { ... }`.',
    criticality: Criticality.medium,
    isDefault: true,
    fileGlobs: ['**/*.php', '**/*.py', '**/*.ts'],
  },
];

async function main() {
  console.log('Seeding default rules...');

  const existingDefaultCount = await prisma.rule.count({
    where: { isDefault: true },
  });

  if (existingDefaultCount === 0) {
    await prisma.rule.createMany({ data: DEFAULT_RULES });
    console.log(`Seeded ${DEFAULT_RULES.length} default rules.`);
  } else {
    console.log(
      `Default rules already exist (${existingDefaultCount}), skipping.`,
    );
  }

  const existingConfig = await prisma.scoringConfig.findFirst();
  if (!existingConfig) {
    await prisma.scoringConfig.create({
      data: { high: 10, medium: 4, low: 1 },
    });
    console.log('Seeded initial ScoringConfig.');
  } else {
    console.log('ScoringConfig already exists, skipping.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
