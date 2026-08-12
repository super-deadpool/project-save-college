import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma 7 moved the connection URL out of schema.prisma: the CLI (migrate,
// studio, seed) reads it from here, while PrismaClient connects through the
// PrismaPg driver adapter in src/lib/db.ts.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: process.env.DATABASE_URL! },
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
});
