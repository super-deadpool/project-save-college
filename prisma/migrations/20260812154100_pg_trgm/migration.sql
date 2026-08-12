-- Trigram text similarity, used by dedup scoring (plan.MD §5) and search (Layer 11).
-- Prisma has no native trigram support, so similarity() is queried via $queryRaw;
-- the GIN indexes themselves are declared on the Complaint model in schema.prisma.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
