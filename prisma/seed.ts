import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import type { LocationType } from '../src/generated/prisma/enums';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const DEMO_PASSWORD = 'password123';

// ---------------------------------------------------------------- SLA profiles

const slaProfiles = [
  {
    code: 'STANDARD',
    name: 'Standard',
    responseCritical: 15,
    resolutionCritical: 240,
    responseHigh: 60,
    resolutionHigh: 1440,
    responseMedium: 240,
    resolutionMedium: 4320,
    responseLow: 1440,
    resolutionLow: 10080,
  },
  {
    code: 'URGENT',
    name: 'Urgent (safety-facing departments)',
    responseCritical: 10,
    resolutionCritical: 120,
    responseHigh: 30,
    resolutionHigh: 720,
    responseMedium: 180,
    resolutionMedium: 2880,
    responseLow: 720,
    resolutionLow: 7200,
  },
];

// ---------------------------------------------------------------- departments

const departments = [
  { code: 'IT', name: 'IT Services', description: 'Campus network, WiFi, labs and computing', sla: 'STANDARD' },
  { code: 'MNT', name: 'Maintenance & Engineering', description: 'Electrical, plumbing, furniture, classroom equipment', sla: 'URGENT' },
  { code: 'HSL', name: 'Hostel Administration', description: 'Hostel rooms, wardens, hostel facilities', sla: 'STANDARD' },
  { code: 'FNB', name: 'Food Services', description: 'Mess, canteen, food quality and hygiene', sla: 'STANDARD' },
  { code: 'SEC', name: 'Campus Security', description: 'Safety, access control, incidents', sla: 'URGENT' },
  { code: 'FAC', name: 'Facilities & Housekeeping', description: 'Cleaning, library, transport and grounds', sla: 'STANDARD' },
];

// ---------------------------------------------------------------- locations

type LocSeed = {
  code: string;
  name: string;
  type: LocationType;
  criticality: number;
  children?: LocSeed[];
};

const locationTree: LocSeed = {
  code: 'CAMPUS',
  name: 'Main Campus',
  type: 'CAMPUS',
  criticality: 0.5,
  children: [
    {
      code: 'CSE',
      name: 'CSE Block',
      type: 'ACADEMIC',
      criticality: 0.7,
      children: [
        {
          code: 'CSE-F1',
          name: 'CSE Block — 1st Floor',
          type: 'ACADEMIC',
          criticality: 0.7,
          children: [
            { code: 'CSE-101', name: 'CSE 101 (Lecture Hall)', type: 'ACADEMIC', criticality: 0.7 },
            { code: 'CSE-102', name: 'CSE 102 (Lecture Hall)', type: 'ACADEMIC', criticality: 0.7 },
            { code: 'CSE-LAB1', name: 'CSE Programming Lab 1', type: 'LAB', criticality: 0.85 },
          ],
        },
        {
          code: 'CSE-F2',
          name: 'CSE Block — 2nd Floor',
          type: 'ACADEMIC',
          criticality: 0.7,
          children: [
            { code: 'CSE-201', name: 'CSE 201 (Exam Hall)', type: 'ACADEMIC', criticality: 0.95 },
            { code: 'CSE-LAB2', name: 'CSE Networks Lab', type: 'LAB', criticality: 0.85 },
          ],
        },
      ],
    },
    {
      code: 'ECE',
      name: 'ECE Block',
      type: 'ACADEMIC',
      criticality: 0.7,
      children: [
        { code: 'ECE-F1', name: 'ECE Block — 1st Floor', type: 'ACADEMIC', criticality: 0.7 },
        { code: 'ECE-LAB1', name: 'ECE Electronics Lab', type: 'LAB', criticality: 0.85 },
        { code: 'ECE-201', name: 'ECE 201 (Exam Hall)', type: 'ACADEMIC', criticality: 0.95 },
      ],
    },
    {
      code: 'MECH',
      name: 'Mechanical Block',
      type: 'ACADEMIC',
      criticality: 0.65,
      children: [
        { code: 'MECH-WS', name: 'Mechanical Workshop', type: 'LAB', criticality: 0.85 },
        { code: 'MECH-101', name: 'MECH 101', type: 'ACADEMIC', criticality: 0.65 },
      ],
    },
    {
      code: 'ADMIN',
      name: 'Administration Block',
      type: 'ADMIN_BLOCK',
      criticality: 0.6,
      children: [{ code: 'ADMIN-ACC', name: 'Accounts Office', type: 'ADMIN_BLOCK', criticality: 0.6 }],
    },
    {
      code: 'LIB',
      name: 'Central Library',
      type: 'LIBRARY',
      criticality: 0.7,
      children: [
        { code: 'LIB-RR', name: 'Library Reading Room', type: 'LIBRARY', criticality: 0.75 },
        { code: 'LIB-DIG', name: 'Digital Library', type: 'LIBRARY', criticality: 0.8 },
      ],
    },
    {
      code: 'HB-A',
      name: 'Boys Hostel A',
      type: 'HOSTEL',
      criticality: 0.6,
      children: [
        {
          code: 'HB-A-F1',
          name: 'Boys Hostel A — 1st Floor',
          type: 'HOSTEL',
          criticality: 0.6,
          children: [
            { code: 'HB-A-101', name: 'Room A-101', type: 'HOSTEL', criticality: 0.55 },
            { code: 'HB-A-102', name: 'Room A-102', type: 'HOSTEL', criticality: 0.55 },
          ],
        },
        {
          code: 'HB-A-F2',
          name: 'Boys Hostel A — 2nd Floor',
          type: 'HOSTEL',
          criticality: 0.6,
          children: [
            { code: 'HB-A-214', name: 'Room A-214', type: 'HOSTEL', criticality: 0.55 },
            { code: 'HB-A-215', name: 'Room A-215', type: 'HOSTEL', criticality: 0.55 },
          ],
        },
        { code: 'HB-A-MESS', name: 'Boys Hostel A Mess', type: 'CANTEEN', criticality: 0.65 },
      ],
    },
    {
      code: 'HB-B',
      name: 'Boys Hostel B',
      type: 'HOSTEL',
      criticality: 0.6,
      children: [
        { code: 'HB-B-F1', name: 'Boys Hostel B — 1st Floor', type: 'HOSTEL', criticality: 0.6 },
        { code: 'HB-B-105', name: 'Room B-105', type: 'HOSTEL', criticality: 0.55 },
        { code: 'HB-B-MESS', name: 'Boys Hostel B Mess', type: 'CANTEEN', criticality: 0.65 },
      ],
    },
    {
      code: 'HG-A',
      name: 'Girls Hostel A',
      type: 'HOSTEL',
      criticality: 0.6,
      children: [
        { code: 'HG-A-F1', name: 'Girls Hostel A — 1st Floor', type: 'HOSTEL', criticality: 0.6 },
        { code: 'HG-A-112', name: 'Room G-112', type: 'HOSTEL', criticality: 0.55 },
        { code: 'HG-A-MESS', name: 'Girls Hostel A Mess', type: 'CANTEEN', criticality: 0.65 },
      ],
    },
    { code: 'CANTEEN', name: 'Main Canteen', type: 'CANTEEN', criticality: 0.6 },
    { code: 'SPORTS', name: 'Sports Complex', type: 'OUTDOOR', criticality: 0.35 },
    { code: 'GROUNDS', name: 'Campus Grounds & Pathways', type: 'OUTDOOR', criticality: 0.35 },
    { code: 'BUSBAY', name: 'Bus Bay', type: 'TRANSPORT', criticality: 0.5 },
    { code: 'PARKING', name: 'Parking Area', type: 'TRANSPORT', criticality: 0.4 },
    { code: 'AUD', name: 'Auditorium', type: 'ACADEMIC', criticality: 0.55 },
  ],
};

// ---------------------------------------------------------------- routing rules

// specificity: category default 0 · locationType override 10 · exact location 20
const categoryDefaults: { category: string; dept: string; confidence: number }[] = [
  { category: 'NETWORK', dept: 'IT', confidence: 0.95 },
  { category: 'LAB_OTHER', dept: 'IT', confidence: 0.6 },
  { category: 'ELECTRICAL', dept: 'MNT', confidence: 0.9 },
  { category: 'WATER', dept: 'MNT', confidence: 0.9 },
  { category: 'FURNITURE', dept: 'MNT', confidence: 0.85 },
  { category: 'CLASSROOM', dept: 'MNT', confidence: 0.8 },
  { category: 'HOSTEL', dept: 'HSL', confidence: 0.9 },
  { category: 'HOSTEL_FOOD', dept: 'FNB', confidence: 0.95 },
  { category: 'CANTEEN', dept: 'FNB', confidence: 0.95 },
  { category: 'SECURITY', dept: 'SEC', confidence: 0.95 },
  { category: 'SANITATION', dept: 'FAC', confidence: 0.9 },
  { category: 'LIBRARY', dept: 'FAC', confidence: 0.85 },
  { category: 'TRANSPORT', dept: 'FAC', confidence: 0.8 },
];

const locationTypeOverrides: {
  category: string;
  locationType: LocationType;
  dept: string;
  confidence: number;
}[] = [
  // Hostel maintenance is handled by the hostel office, not central maintenance.
  { category: 'ELECTRICAL', locationType: 'HOSTEL', dept: 'HSL', confidence: 0.85 },
  { category: 'WATER', locationType: 'HOSTEL', dept: 'HSL', confidence: 0.85 },
  { category: 'FURNITURE', locationType: 'HOSTEL', dept: 'HSL', confidence: 0.85 },
  { category: 'SANITATION', locationType: 'HOSTEL', dept: 'HSL', confidence: 0.8 },
  // Lab equipment in a lab is IT/technical; elsewhere it is maintenance.
  { category: 'ELECTRICAL', locationType: 'LAB', dept: 'MNT', confidence: 0.9 },
];

// ---------------------------------------------------------------- users

const demoUsers = [
  { email: 'student@campus.edu', name: 'Aditi Rao', role: 'STUDENT' as const, dept: null, rollNumber: 'CS21B012', hostelBlock: 'HG-A' },
  { email: 'student2@campus.edu', name: 'Rahul Menon', role: 'STUDENT' as const, dept: null, rollNumber: 'EC21B045', hostelBlock: 'HB-A' },
  { email: 'student3@campus.edu', name: 'Farhan Qureshi', role: 'STUDENT' as const, dept: null, rollNumber: 'ME21B078', hostelBlock: 'HB-B' },
  { email: 'student4@campus.edu', name: 'Neha Gupta', role: 'STUDENT' as const, dept: null, rollNumber: 'CS21B099', hostelBlock: 'HG-A' },
  { email: 'staff@campus.edu', name: 'Suresh Kumar', role: 'STAFF' as const, dept: 'IT' },
  { email: 'staff.mnt@campus.edu', name: 'Ramesh Iyer', role: 'STAFF' as const, dept: 'MNT' },
  { email: 'manager@campus.edu', name: 'Priya Nair', role: 'DEPT_MANAGER' as const, dept: 'IT' },
  { email: 'manager.mnt@campus.edu', name: 'Vikram Shah', role: 'DEPT_MANAGER' as const, dept: 'MNT' },
  { email: 'admin@campus.edu', name: 'Dr. Meera Krishnan', role: 'ADMIN' as const, dept: null },
];

// ---------------------------------------------------------------- run

async function seedLocations(node: LocSeed, parentId: string | null) {
  const row = await prisma.location.upsert({
    where: { code: node.code },
    update: { name: node.name, type: node.type, criticality: node.criticality, parentId },
    create: { code: node.code, name: node.name, type: node.type, criticality: node.criticality, parentId },
  });
  for (const child of node.children ?? []) await seedLocations(child, row.id);
}

async function main() {
  for (const p of slaProfiles) {
    await prisma.slaProfile.upsert({ where: { code: p.code }, update: p, create: p });
  }

  const slaByCode = Object.fromEntries(
    (await prisma.slaProfile.findMany()).map((p) => [p.code, p.id]),
  );

  for (const d of departments) {
    const data = {
      code: d.code,
      name: d.name,
      description: d.description,
      slaProfileId: slaByCode[d.sla],
    };
    await prisma.department.upsert({ where: { code: d.code }, update: data, create: data });
  }

  const deptByCode = Object.fromEntries(
    (await prisma.department.findMany()).map((d) => [d.code, d.id]),
  );

  await seedLocations(locationTree, null);
  const locByCode = Object.fromEntries(
    (await prisma.location.findMany()).map((l) => [l.code, l.id]),
  );

  // Routing rules are fully re-derived on each seed run.
  await prisma.routingRule.deleteMany();
  await prisma.routingRule.createMany({
    data: [
      ...categoryDefaults.map((r) => ({
        categoryKey: r.category,
        departmentId: deptByCode[r.dept],
        specificity: 0,
        confidence: r.confidence,
      })),
      ...locationTypeOverrides.map((r) => ({
        categoryKey: r.category,
        locationType: r.locationType,
        departmentId: deptByCode[r.dept],
        specificity: 10,
        confidence: r.confidence,
      })),
    ],
  });

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  for (const u of demoUsers) {
    const data = {
      email: u.email,
      name: u.name,
      role: u.role,
      passwordHash,
      departmentId: u.dept ? deptByCode[u.dept] : null,
      rollNumber: 'rollNumber' in u ? u.rollNumber : null,
      hostelBlock: 'hostelBlock' in u ? u.hostelBlock : null,
    };
    await prisma.user.upsert({ where: { email: u.email }, update: data, create: data });
  }

  console.log(
    `Seeded: ${Object.keys(deptByCode).length} departments, ${Object.keys(locByCode).length} locations, ` +
      `${categoryDefaults.length + locationTypeOverrides.length} routing rules, ${demoUsers.length} users ` +
      `(password: ${DEMO_PASSWORD})`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
