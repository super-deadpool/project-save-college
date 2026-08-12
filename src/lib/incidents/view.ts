import { prisma } from '@/lib/db';
import { incidentPriority } from './priority';
import { incidentMessage, isSharedIncident, type IncidentFacts } from './message';
import type { SessionPayload } from '@/lib/auth/jwt';

/**
 * One loader behind both the incident page and `GET /api/incidents/[id]`, so the
 * count a student is shown and the count a staff member is shown can never
 * disagree.
 *
 * `Incident` has no `departmentId` column by design (plan.MD §6) — every member
 * shares a category and a location family, so they route to the same department
 * and it is derived rather than stored. Deriving keeps routing decisions in one
 * place (§15) instead of copying them onto a second row that could go stale.
 */
export async function loadIncident(incidentId: string) {
  const incident = await prisma.incident.findUnique({
    where: { id: incidentId },
    include: {
      location: true,
      complaints: {
        orderBy: { createdAt: 'asc' },
        include: { department: true, reporter: true },
      },
    },
  });
  if (!incident) return null;

  const departments = new Map<string, string>();
  for (const c of incident.complaints) {
    if (c.department) departments.set(c.department.id, c.department.name);
  }
  // Ties go to the first-reported member's department — the incident's opener.
  const departmentName = incident.complaints.find((c) => c.department)?.department?.name ?? null;

  const rollup = incidentPriority(
    incident.complaints.map((c) => c.priority),
    incident.affectedCount,
  );

  const facts: IncidentFacts = {
    code: incident.code,
    title: incident.title,
    status: incident.status,
    priority: incident.priority,
    affectedCount: incident.affectedCount,
    departmentName,
  };

  return {
    incident,
    facts,
    rollup,
    departmentName,
    departmentCount: departments.size,
    isShared: isSharedIncident(incident.affectedCount),
    message: incidentMessage(facts),
  };
}

export type IncidentView = NonNullable<Awaited<ReturnType<typeof loadIncident>>>;

/**
 * Who may open an incident. A student sees one only through their own complaint
 * — they are a member, not an observer — and even then the member list is
 * stripped of everyone else's identity before it reaches them.
 */
export function canViewIncident(view: IncidentView, session: SessionPayload): boolean {
  if (session.role === 'ADMIN') return true;
  if (view.incident.complaints.some((c) => c.reporterId === session.sub)) return true;
  return (
    session.departmentId != null &&
    view.incident.complaints.some((c) => c.departmentId === session.departmentId)
  );
}

/** §26 is Layer 7, but the flag already exists — never leak a name it hides. */
export function reporterLabel(
  complaint: { isAnonymous: boolean; reporter: { name: string } },
  viewerRole: string,
): string {
  if (complaint.isAnonymous && viewerRole !== 'ADMIN') return 'Anonymous';
  return complaint.reporter.name;
}
