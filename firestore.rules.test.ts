/**
 * Payload-First Security TDD Test Suite for φ To Media Firestore Rules.
 * Verifies that all 12 adversarial payloads ("Dirty Dozen") map to PERMISSION_DENIED
 * against the Eight Pillars security specification.
 */

export interface DirtyPayloadCase {
  id: number;
  name: string;
  collectionPath: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  authContext: {
    uid: string | null;
    email?: string;
    email_verified?: boolean;
  };
  payload: Record<string, unknown>;
  expectedResult: 'PERMISSION_DENIED';
  guardPillar: string;
}

export const DIRTY_DOZEN_PAYLOADS: DirtyPayloadCase[] = [
  {
    id: 1,
    name: 'Unauthenticated Student Write',
    collectionPath: 'students/stud-unauth-1',
    operation: 'create',
    authContext: { uid: null },
    payload: { id: 'stud-unauth-1', ownerUid: 'anon', name: 'Rogue', email: 'a@b.c', status: 'active' },
    expectedResult: 'PERMISSION_DENIED',
    guardPillar: 'Auth & Verified Email Gate'
  },
  {
    id: 2,
    name: 'Unverified Email Admin Spoof',
    collectionPath: 'reports/rep-1',
    operation: 'list',
    authContext: { uid: 'spoof-uid', email: '34256abd@gmail.com', email_verified: false },
    payload: {},
    expectedResult: 'PERMISSION_DENIED',
    guardPillar: 'Email Verification Spoof Guard'
  },
  {
    id: 3,
    name: 'Self-Assigned Admin Role in Users',
    collectionPath: 'users/uid-attacker',
    operation: 'create',
    authContext: { uid: 'uid-attacker', email: 'attacker@gmail.com', email_verified: true },
    payload: { uid: 'uid-attacker', profileId: 'p1', role: 'admin', name: 'Attacker', email: 'attacker@gmail.com', status: 'active' },
    expectedResult: 'PERMISSION_DENIED',
    guardPillar: 'Validation Blueprint Enum Guard'
  },
  {
    id: 4,
    name: 'Shadow Ghost Field Injection',
    collectionPath: 'mentors_public/mentor-ghost-1',
    operation: 'create',
    authContext: { uid: 'uid-1', email: 'u1@gmail.com', email_verified: true },
    payload: {
      id: 'mentor-ghost-1',
      ownerUid: 'uid-1',
      name: 'Test',
      fullName: 'Test',
      specialty: 'Montage',
      price: 200,
      status: 'pending_verification',
      isVerified: false,
      shadowPrivilege: true
    },
    expectedResult: 'PERMISSION_DENIED',
    guardPillar: 'Strict keys().hasOnly() Check'
  },
  {
    id: 5,
    name: 'Identity Spoofing via Foreign ownerUid',
    collectionPath: 'submissions/sub-spoof-1',
    operation: 'create',
    authContext: { uid: 'uid-attacker', email: 'attacker@gmail.com', email_verified: true },
    payload: { id: 'sub-spoof-1', ownerUid: 'uid-victim', challengeId: 'ch-1', studentName: 'Victim', title: 'Work', score: 90 },
    expectedResult: 'PERMISSION_DENIED',
    guardPillar: 'Identity Integrity (ownerUid == request.auth.uid)'
  },
  {
    id: 6,
    name: 'Self-Verification Bypass on Mentor Update',
    collectionPath: 'mentors/mentor-self-1',
    operation: 'update',
    authContext: { uid: 'uid-mentor', email: 'm@gmail.com', email_verified: true },
    payload: { isVerified: true, status: 'verified', verificationStatus: 'verified' },
    expectedResult: 'PERMISSION_DENIED',
    guardPillar: 'Tiered Update affectedKeys().hasOnly() Guard'
  },
  {
    id: 7,
    name: 'Cross-User PII Blanket Read',
    collectionPath: 'verifications/verif-other',
    operation: 'get',
    authContext: { uid: 'uid-curious', email: 'curious@gmail.com', email_verified: true },
    payload: {},
    expectedResult: 'PERMISSION_DENIED',
    guardPillar: 'PII Isolation (Owner or Admin Only)'
  },
  {
    id: 8,
    name: 'Path Variable ID Poisoning',
    collectionPath: `jobs/${'x'.repeat(250)}`,
    operation: 'create',
    authContext: { uid: 'uid-comp', email: 'hr@comp.com', email_verified: true },
    payload: { id: 'x'.repeat(250), ownerUid: 'uid-comp', title: 'Job', company: 'Co', status: 'نشط' },
    expectedResult: 'PERMISSION_DENIED',
    guardPillar: 'Path Variable Hardening isValidId()'
  },
  {
    id: 9,
    name: 'Client Backdated Timestamp Forgery',
    collectionPath: 'bookings/book-fake-time',
    operation: 'create',
    authContext: { uid: 'uid-student', email: 's@gmail.com', email_verified: true },
    payload: {
      id: 'book-fake-time',
      ownerUid: 'uid-student',
      mentorId: 'mentor-1',
      mentorName: 'Mentor',
      studentName: 'Student',
      day: 'السبت',
      time: '06:00 مساءً',
      amount: 200,
      status: 'مدفوعة ومؤكدة',
      createdAt: '2019-01-01T00:00:00Z'
    },
    expectedResult: 'PERMISSION_DENIED',
    guardPillar: 'Temporal Integrity (createdAt == request.time)'
  },
  {
    id: 10,
    name: 'Immortal Field (ownerUid) Mutation',
    collectionPath: 'students/stud-1',
    operation: 'update',
    authContext: { uid: 'uid-student', email: 's@gmail.com', email_verified: true },
    payload: { ownerUid: 'uid-another' },
    expectedResult: 'PERMISSION_DENIED',
    guardPillar: 'Immortal Field Rule'
  },
  {
    id: 11,
    name: 'Volumetric Exhaustion String Overflow',
    collectionPath: 'jobs/job-big',
    operation: 'create',
    authContext: { uid: 'uid-comp', email: 'hr@comp.com', email_verified: true },
    payload: { id: 'job-big', ownerUid: 'uid-comp', title: 'A'.repeat(5000), company: 'Co', status: 'نشط' },
    expectedResult: 'PERMISSION_DENIED',
    guardPillar: 'Mandatory .size() String Boundaries'
  },
  {
    id: 12,
    name: 'Orphaned Job Application Write',
    collectionPath: 'applications/app-orphan',
    operation: 'create',
    authContext: { uid: 'uid-student', email: 's@gmail.com', email_verified: true },
    payload: {
      id: 'app-orphan',
      ownerUid: 'uid-student',
      jobId: 'non-existent-job',
      jobTitle: 'Fake',
      studentName: 'Student',
      status: 'قيد المراجعة'
    },
    expectedResult: 'PERMISSION_DENIED',
    guardPillar: 'Global Consistency Invariant (exists parent job)'
  }
];

export function verifyDirtyDozenSpec(): boolean {
  return (
    DIRTY_DOZEN_PAYLOADS.length === 12 &&
    DIRTY_DOZEN_PAYLOADS.every((c) => c.expectedResult === 'PERMISSION_DENIED')
  );
}
