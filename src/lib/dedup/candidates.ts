import { prisma } from '@/lib/db';
import { parseSignature } from '@/lib/engine/classify';
import { ancestryIndex } from '@/lib/locations';
import type { DedupCandidate } from './score';

/**
 * The impure half of dedup: everything the pure scorer needs, fetched in two
 * queries. Kept apart from `score.ts` on purpose (CLAUDE.md §5) — the weights and
 * thresholds stay unit-testable, and this file holds the one thing they cannot
 * do without a database, trigram text similarity.
 *
 * `pg_trgm` has no Prisma binding, so `similarity()` runs through `$queryRaw`
 * (the GIN indexes are declared on the model and created by the trgm migration).
 */

/** Only a live incident can absorb a new report. */
const OPEN_INCIDENT_STATUSES = ['OPEN', 'IN_PROGRESS'] as const;

/** A safety valve, not a tuning knob — the window plus category already narrow this hard. */
const CANDIDATE_LIMIT = 100;

export interface CandidateQuery {
  categoryKey: string;
  /** Excluded from its own candidate set. */
  complaintId: string;
  title: string;
  description: string;
  createdAt: Date;
  windowHours: number;
}

interface CandidateRow {
  id: string;
  code: string;
  incidentId: string;
  reporterId: string;
  categoryKey: string;
  subcategoryKey: string | null;
  locationId: string | null;
  signature: string | null;
  createdAt: Date;
  text_similarity: number;
}

export async function findCandidates(query: CandidateQuery): Promise<DedupCandidate[]> {
  const since = new Date(query.createdAt.getTime() - query.windowHours * 3_600_000);

  // Candidates are drawn by category + window + open incident only. Signature
  // equality is deliberately *not* a filter: an unanswered scope question would
  // otherwise make a complaint unmatchable, and the signature is only 0.55 of
  // the score by design (plan.MD §5).
  const rows = await prisma.$queryRaw<CandidateRow[]>`
    SELECT c."id",
           c."code",
           c."incidentId",
           c."reporterId",
           c."categoryKey",
           c."subcategoryKey",
           c."locationId",
           c."signature",
           c."createdAt",
           GREATEST(
             similarity(c."title", ${query.title}),
             similarity(c."description", ${query.description})
           )::float8 AS text_similarity
      FROM "Complaint" c
      JOIN "Incident" i ON i."id" = c."incidentId"
     WHERE c."categoryKey" = ${query.categoryKey}
       AND c."id" <> ${query.complaintId}
       AND c."createdAt" >= ${since}
       AND c."createdAt" <= ${query.createdAt}
       AND i."status" = ANY(${[...OPEN_INCIDENT_STATUSES]}::"IncidentStatus"[])
     ORDER BY c."createdAt" DESC
     LIMIT ${CANDIDATE_LIMIT}
  `;

  if (rows.length === 0) return [];

  const ancestry = await ancestryIndex();

  return rows.map((row) => ({
    complaintId: row.id,
    complaintCode: row.code,
    incidentId: row.incidentId,
    reporterId: row.reporterId,
    categoryKey: row.categoryKey,
    subcategoryKey: row.subcategoryKey,
    // The bucket is not a column; it is the fourth leg of the stored signature,
    // which is exactly why the signature is a readable composite and not a hash.
    scopeBucket: parseSignature(row.signature).scopeBucket,
    locationId: row.locationId,
    locationAncestorIds: row.locationId ? (ancestry.get(row.locationId) ?? [row.locationId]) : [],
    createdAt: row.createdAt,
    textSimilarity: row.text_similarity ?? 0,
  }));
}
