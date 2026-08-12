import { describe, expect, it } from 'vitest';
import {
  escalationFor,
  incidentPriority,
  peakPriority,
  raiseBand,
  SCALE_ESCALATIONS,
} from '@/lib/incidents/priority';
import { incidentMessage, isSharedIncident } from '@/lib/incidents/message';
import { buildIncidentTitle } from '@/lib/incidents/service';
import type { Classification } from '@/lib/engine/classify';

describe('incident priority — worst member, then scale', () => {
  it('takes the worst member rather than an average', () => {
    expect(peakPriority(['LOW', 'MEDIUM', 'CRITICAL', 'LOW'])).toBe('CRITICAL');
    expect(incidentPriority(['LOW', 'HIGH', 'LOW'], 1).priority).toBe('HIGH');
  });

  it('does not escalate below the first threshold', () => {
    expect(escalationFor(4)).toBe(0);
    expect(incidentPriority(['MEDIUM'], 4).priority).toBe('MEDIUM');
  });

  it('raises one band at 5 affected students', () => {
    const result = incidentPriority(['MEDIUM', 'MEDIUM', 'LOW', 'MEDIUM', 'LOW'], 5);
    expect(result.priority).toBe('HIGH');
    expect(result.bandsEscalated).toBe(1);
    expect(result.reason).toContain('5 students affected');
  });

  it('raises two bands at 20 — a campus-scale fault', () => {
    expect(incidentPriority(['LOW'], 20).priority).toBe('HIGH');
    expect(incidentPriority(['MEDIUM'], 20).priority).toBe('CRITICAL');
  });

  it('keeps furniture from becoming an emergency on a handful of reports', () => {
    // §14 puts furniture lowest. A LOW chair complaint needs 20 reporters to
    // reach HIGH and can never reach CRITICAL on scale alone.
    expect(incidentPriority(['LOW', 'LOW', 'LOW', 'LOW', 'LOW'], 5).priority).toBe('MEDIUM');
    expect(incidentPriority(Array(20).fill('LOW'), 20).priority).toBe('HIGH');
  });

  it('caps at CRITICAL and reports what actually moved', () => {
    const result = incidentPriority(['CRITICAL'], 40);
    expect(result.priority).toBe('CRITICAL');
    expect(result.bandsEscalated).toBe(0);
    expect(result.reason).toContain('most urgent report');
  });

  it('raiseBand never falls off the ladder', () => {
    expect(raiseBand('CRITICAL', 3)).toBe('CRITICAL');
    expect(raiseBand('LOW', 0)).toBe('LOW');
  });

  it('thresholds are ordered highest-first, so the first match is the strongest', () => {
    const affected = SCALE_ESCALATIONS.map((e) => e.affected);
    expect([...affected].sort((a, b) => b - a)).toEqual(affected);
    expect(escalationFor(25)).toBe(2);
  });
});

describe('§36 — smart incident communication', () => {
  const facts = {
    code: 'INC-001',
    title: 'CSE Block — Complete outage',
    status: 'IN_PROGRESS' as const,
    priority: 'HIGH' as const,
    affectedCount: 47,
    departmentName: 'IT Department',
  };

  it('replaces the generic acknowledgement with the situation', () => {
    const message = incidentMessage(facts);
    expect(message.body).toContain('IT Department');
    expect(message.body).toContain('multiple students');
    expect(message.statusLabel).toBe('In progress');
  });

  it('counts the *other* students, since the reader is one of them (§18)', () => {
    expect(incidentMessage(facts).affectedLine).toContain('46 other students');
    expect(incidentMessage({ ...facts, affectedCount: 2 }).affectedLine).toContain('1 other student');
  });

  it('tells the student not to file again — the point of §36', () => {
    expect(incidentMessage(facts).reassurance).toContain("don't need to submit another");
  });

  it('names the campus office when nothing is routed yet (§39)', () => {
    const message = incidentMessage({ ...facts, departmentName: null });
    expect(message.body).toContain('The campus office');
  });

  it('changes to a resolution message once the incident closes', () => {
    expect(incidentMessage({ ...facts, status: 'RESOLVED' }).body).toContain('resolved');
  });

  it('is never shown for a solitary report — a size-1 incident is just a complaint', () => {
    expect(isSharedIncident(1)).toBe(false);
    expect(isSharedIncident(2)).toBe(true);
  });
});

describe('incident titles — §17 reads "where — what"', () => {
  const classification = (over: Partial<Classification> = {}) =>
    ({
      categoryKey: 'NETWORK',
      categoryLabel: 'WiFi / Internet',
      subcategoryKey: 'NO_CONNECTION',
      subcategoryLabel: 'Complete outage',
      locationName: 'CSE Block',
      ...over,
    }) as Classification;

  it('pairs the location with the specific problem', () => {
    expect(buildIncidentTitle(classification())).toBe('CSE Block — Complete outage');
  });

  it('falls back to the category when the subcategory was never established', () => {
    expect(buildIncidentTitle(classification({ subcategoryLabel: null }))).toBe(
      'CSE Block — WiFi / Internet',
    );
  });

  it('drops the dash rather than trailing an empty location', () => {
    expect(buildIncidentTitle(classification({ locationName: null }))).toBe('Complete outage');
  });
});
