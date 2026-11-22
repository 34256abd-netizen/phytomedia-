# φ To Media — Security Architecture & Payload-First TDD Specification

## 1. Data Invariants
1. **Master Auth & Email Verification Invariant**: Every write operation (`create`, `update`, `delete`) requires `request.auth != null` and `request.auth.token.email_verified == true`.
2. **Ownership & Anti-Spoofing Invariant**: Every user-owned document (`users/{uid}`, `students`, `mentors`, `companies`, `verifications`, `submissions`, `bookings`, `portfolio_items`) binds `ownerUid == request.auth.uid` on creation and keeps `ownerUid` and `createdAt` immutable on updates.
3. **Zero Privilege Escalation**: Clients can NEVER create or update an `admins/{uid}` document directly (except an already-verified bootstrapped admin), and `users/{uid}` strictly allows `role in ['student', 'mentor', 'company']` with `role` immutable post-creation.
4. **Verification Lifecycle Integrity**: Mentors (`mentors`, `mentors_public`), companies (`companies`), verifications (`verifications`), and portfolio items (`portfolio_items`) always start in pending state (`isVerified == false`, `status == 'pending_verification'` or `'pending'` or `'approved'` only if set by admin) and only `isAdmin()` can promote them to `'verified'`/`'approved'` or `'frozen'`/`'rejected'`.
5. **PII Isolation Invariant**: Email addresses, phone numbers, IBANs, ID proofs, and commercial registers NEVER appear in public collections (`mentors_public`, `students_public`, `challenges`, `jobs`). Private PII collections allow `get`/`list` strictly for `ownerUid == request.auth.uid` or `isAdmin()`.
6. **Parent Reference Existence Invariant**: A `JobApplication` (`applications/{appId}`) cannot be created unless the referenced `jobs/{jobId}` document exists in Firestore.
7. **Temporal & Volumetric Integrity**: Every `createdAt` and `updatedAt` equals `request.time` server timestamp; every document ID matches `^[a-zA-Z0-9_\-]+$` with max length 128; every string and list field enforces explicit `.size()` boundaries matching `firebase-blueprint.json`.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Write**: Creating a `students/{id}` document with `request.auth == null` -> `PERMISSION_DENIED`.
2. **Unverified Email Spoofing**: Authenticated user with `token.email == '34256abd@gmail.com'` and `token.email_verified == false` reading/writing admin data -> `PERMISSION_DENIED`.
3. **Self-Admin Escalation**: Student setting `role: 'admin'` in `users/{uid}` or writing `/admins/{uid}` -> `PERMISSION_DENIED`.
4. **Shadow Field Injection ("Ghost Field")**: Mentor registration payload containing `{ ...validFields, extraAdminFlag: true }` -> `PERMISSION_DENIED` (`hasOnly` check).
5. **Owner Hijacking**: Student creating a submission with `ownerUid: 'other_victim_uid'` -> `PERMISSION_DENIED`.
6. **Self-Verification Bypass**: Mentor updating their own `mentors/{id}` or `mentors_public/{id}` with `isVerified: true, status: 'verified'` -> `PERMISSION_DENIED`.
7. **Cross-User PII Read**: Signed-in student attempting `get` or `list` on another user's `/students/{otherId}` or `/verifications/{otherId}` -> `PERMISSION_DENIED`.
8. **ID Poisoning**: Document creation at `/jobs/../../etc/passwd` or 500-char ID violating `isValidId()` -> `PERMISSION_DENIED`.
9. **Client Timestamp Forgery**: Creating a job with `createdAt: '2020-01-01T00:00:00Z'` instead of `request.time` -> `PERMISSION_DENIED`.
10. **Immutable Field Mutation**: Updating `students/{id}` to overwrite `ownerUid` or `createdAt` -> `PERMISSION_DENIED`.
11. **Oversized String / Denial of Wallet**: Sending a 50KB bio/title string on `jobs/{id}` -> `PERMISSION_DENIED`.
12. **Orphaned Application**: Creating `/applications/{appId}` referencing a non-existent `jobId: 'ghost_job_999'` -> `PERMISSION_DENIED`.
