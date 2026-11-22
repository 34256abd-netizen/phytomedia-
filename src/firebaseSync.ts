import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  serverTimestamp,
  writeBatch,
  Unsubscribe
} from 'firebase/firestore';
import { User } from 'firebase/auth';
import {
  db,
  auth,
  OperationType,
  handleFirestoreError,
  testConnection,
  signInWithGooglePopup,
  signOutFirebase,
  subscribeAuthState,
  getCurrentAuthUser
} from './firebase';

export const GUEST_PENDING_CV_KEY = 'phi_guest_cv_pending';
export const GUEST_PENDING_PORTFOLIO_KEY = 'phi_guest_portfolio_pending';
export const GUEST_PENDING_PROGRESS_KEY = 'phi_guest_progress_pending';
export const GUEST_PENDING_RATINGS_KEY = 'phi_guest_pending_ratings_v1';
export const GUEST_PENDING_SUBMISSIONS_KEY = 'phi_guest_pending_submissions_v1';
export const GUEST_PENDING_JOBS_KEY = 'phi_guest_pending_jobs_v1';
export const GUEST_PENDING_APPS_KEY = 'phi_guest_pending_apps_v1';
export const GUEST_PENDING_BOOKINGS_KEY = 'phi_guest_pending_bookings_v1';
export const GUEST_PENDING_REPORTS_KEY = 'phi_guest_pending_reports_v1';

export function queueGuestPendingItem(storageKey: string, item: any): void {
  try {
    const raw = localStorage.getItem(storageKey);
    const list = raw ? JSON.parse(raw) : [];
    const arr = Array.isArray(list) ? list : [];
    arr.push(item);
    localStorage.setItem(storageKey, JSON.stringify(arr.slice(-50)));
  } catch (err) {
    console.warn('Could not queue guest pending item:', err);
  }
}

export function hasMeaningfulCVData(cv: any): boolean {
  if (!cv || typeof cv !== 'object') return false;
  const textFields = ['photo', 'fullName', 'jobTitle', 'email', 'phone', 'address', 'linkedin', 'summary'];
  if (textFields.some((k) => typeof cv[k] === 'string' && cv[k].trim().length > 0)) return true;
  if (cv.education && typeof cv.education === 'object') {
    if (Object.values(cv.education).some((v) => typeof v === 'string' && v.trim().length > 0)) return true;
  }
  const listFields = ['experiences', 'mediaSkills', 'techSkills', 'certificates', 'volunteering'];
  if (listFields.some((k) => Array.isArray(cv[k]) && cv[k].length > 0)) return true;
  if (Array.isArray(cv.languages) && (cv.languages.length > 1 || (cv.languages[0] && cv.languages[0].name !== 'اللغة العربية'))) {
    return true;
  }
  return false;
}

export const ADMIN_EMAILS = ['34256abd@gmail.com', 'phytomedia10@gmail.com'];

export function isFirebaseAdminUser(user: User | null = auth.currentUser): boolean {
  if (!user || !user.emailVerified || !user.email) return false;
  return ADMIN_EMAILS.includes(user.email.trim().toLowerCase());
}

export function sanitizeId(raw: unknown, prefix = 'doc'): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .slice(0, 120);
  if (cleaned.length >= 1) return cleaned;
  return `${prefix}-${Date.now()}`;
}

function clampStr(val: unknown, maxLen: number, fallback = ''): string {
  const s = typeof val === 'string' ? val.trim() : String(val ?? '').trim();
  if (!s) return fallback;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function clampNum(val: unknown, min = 0, max = 100000, fallback = 0): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampMediaRef(val: unknown, maxLen = 150000, placeholder = '[مستند مرفق محفوظ محلياً]'): string {
  if (typeof val !== 'string' || !val.trim()) return '';
  if (val.length > maxLen) return placeholder;
  return val;
}

function mergeById<T extends { id?: string }>(localList: T[], remoteList: T[], preferRemote = true): T[] {
  const map = new Map<string, T>();
  if (Array.isArray(localList)) {
    for (const item of localList) {
      if (item && item.id) map.set(String(item.id), item);
    }
  }
  if (Array.isArray(remoteList)) {
    for (const rItem of remoteList) {
      if (!rItem || !rItem.id) continue;
      const key = String(rItem.id);
      const existing = map.get(key);
      if (!existing || preferRemote) {
        map.set(key, { ...(existing || {}), ...rItem });
      } else {
        map.set(key, { ...rItem, ...existing });
      }
    }
  }
  return Array.from(map.values());
}

export async function ensureGoogleAuth(): Promise<User> {
  if (auth.currentUser && auth.currentUser.emailVerified) {
    return auth.currentUser;
  }
  const user = await signInWithGooglePopup();
  return user;
}

export async function forceGoogleSignIn(): Promise<User> {
  return signInWithGooglePopup();
}

export async function firebaseSignOut(): Promise<void> {
  await signOutFirebase();
}

export function getFirebaseAuthStateSnapshot() {
  const u = auth.currentUser;
  return {
    isSignedIn: Boolean(u && u.emailVerified),
    uid: u?.uid || null,
    email: u?.email || null,
    displayName: u?.displayName || null,
    isAdmin: isFirebaseAdminUser(u)
  };
}

let activeUnsubs: Unsubscribe[] = [];
let publicUnsubs: Unsubscribe[] = [];
let syncStateRef: any = null;
let syncPortfolioRef: any = null;
let syncCvStateRef: any = null;
let onHydrateRef: (() => void) | null = null;
let bootInitialized = false;

function normalizePortfolioDoc(raw: any) {
  const url = typeof raw?.url === 'string' ? raw.url : (typeof raw?.fileUrl === 'string' ? raw.fileUrl : '');
  const desc = typeof raw?.description === 'string' ? raw.description : (typeof raw?.desc === 'string' ? raw.desc : '');
  return {
    ...raw,
    url,
    fileUrl: raw?.fileUrl || url,
    desc,
    description: desc,
    tools: typeof raw?.tools === 'string' ? raw.tools : '',
    mode: raw?.mode || (url && !url.startsWith('idb://') && !url.startsWith('data:') ? 'link' : 'file'),
    fileName: typeof raw?.fileName === 'string' ? raw.fileName : '',
    fileSizeStr: typeof raw?.fileSizeStr === 'string' ? raw.fileSizeStr : ''
  };
}

function sanitizeUserCVData(cvData: any, uid: string) {
  const edu = (cvData?.education && typeof cvData.education === 'object') ? cvData.education : {};
  const cleanExperiences = Array.isArray(cvData?.experiences)
    ? cvData.experiences.slice(0, 50).map((exp: any) => ({
        role: clampStr(exp?.role, 120),
        company: clampStr(exp?.company, 120),
        period: clampStr(exp?.period, 80),
        desc: clampStr(exp?.desc, 600)
      }))
    : [];
  const cleanMediaSkills = Array.isArray(cvData?.mediaSkills)
    ? cvData.mediaSkills.slice(0, 30).map((s: any) => ({
        name: clampStr(s?.name, 80),
        level: clampNum(s?.level, 1, 5, 3)
      }))
    : [];
  const cleanTechSkills = Array.isArray(cvData?.techSkills)
    ? cvData.techSkills.slice(0, 50).map((t: unknown) => clampStr(t, 80)).filter(Boolean)
    : [];
  const cleanLanguages = Array.isArray(cvData?.languages)
    ? cvData.languages.slice(0, 20).map((l: any) => ({
        name: clampStr(l?.name, 80),
        level: clampStr(l?.level, 80)
      }))
    : [{ name: 'اللغة العربية', level: 'لغة أم (Native)' }];
  const cleanCertificates = Array.isArray(cvData?.certificates)
    ? cvData.certificates.slice(0, 40).map((c: any) => ({
        title: clampStr(c?.title, 160),
        issuer: clampStr(c?.issuer, 160),
        year: clampStr(c?.year, 32),
        linkOrImg: clampStr(c?.linkOrImg, 400)
      }))
    : [];
  const cleanVolunteering = Array.isArray(cvData?.volunteering)
    ? cvData.volunteering.slice(0, 40).map((v: any) => ({
        name: clampStr(v?.name, 160),
        role: clampStr(v?.role, 120),
        year: clampStr(v?.year, 32),
        desc: clampStr(v?.desc, 400)
      }))
    : [];

  return {
    uid,
    photo: clampMediaRef(cvData?.photo, 150000, ''),
    fullName: clampStr(cvData?.fullName, 160),
    jobTitle: clampStr(cvData?.jobTitle, 160),
    email: clampStr(cvData?.email, 160),
    phone: clampStr(cvData?.phone, 40),
    address: clampStr(cvData?.address, 200),
    linkedin: clampStr(cvData?.linkedin, 500),
    summary: clampStr(cvData?.summary, 4000),
    experiences: cleanExperiences,
    education: {
      university: clampStr(edu.university, 160),
      faculty: clampStr(edu.faculty, 160),
      department: clampStr(edu.department, 120),
      gradYear: clampStr(edu.gradYear, 32),
      grade: clampStr(edu.grade, 60),
      gradProject: clampStr(edu.gradProject, 300)
    },
    mediaSkills: cleanMediaSkills,
    techSkills: cleanTechSkills,
    languages: cleanLanguages,
    certificates: cleanCertificates,
    volunteering: cleanVolunteering,
    lastSaved: clampStr(cvData?.lastSaved, 64, new Date().toISOString())
  };
}

function clearSubs(list: Unsubscribe[]) {
  while (list.length > 0) {
    const unsub = list.pop();
    try {
      if (typeof unsub === 'function') unsub();
    } catch (_) {}
  }
}

function triggerHydrate() {
  if (typeof onHydrateRef === 'function') {
    onHydrateRef();
  }
}

function attachPublicListeners() {
  clearSubs(publicUnsubs);

  // 1. Public Mentors Directory (Zero PII)
  try {
    const qMentors = query(
      collection(db, 'mentors_public'),
      where('status', 'in', ['pending_verification', 'verified'])
    );
    publicUnsubs.push(
      onSnapshot(
        qMentors,
        (snap) => {
          if (!syncStateRef || isFirebaseAdminUser(auth.currentUser)) return;
          const remoteMentors = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
          // Keep owner's private mentor record fields if present for current user's own mentor doc
          const ownPrivate = (syncStateRef.mentors || []).filter(
            (m: any) => m && auth.currentUser && m.ownerUid === auth.currentUser.uid
          );
          syncStateRef.mentors = mergeById(remoteMentors, ownPrivate, true);
          triggerHydrate();
        },
        (err) => {
          handleFirestoreError(err, OperationType.LIST, 'mentors_public');
        }
      )
    );
  } catch (err) {
    console.warn('Could not attach mentors_public listener:', err);
  }

  // 2. Active Jobs
  try {
    const qJobs = query(collection(db, 'jobs'), where('status', '==', 'نشط'));
    publicUnsubs.push(
      onSnapshot(
        qJobs,
        (snap) => {
          if (!syncStateRef || isFirebaseAdminUser(auth.currentUser)) return;
          syncStateRef.jobs = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
          triggerHydrate();
        },
        (err) => {
          handleFirestoreError(err, OperationType.LIST, 'jobs');
        }
      )
    );
  } catch (err) {
    console.warn('Could not attach jobs listener:', err);
  }

  // 3. Active Challenges
  try {
    const qChallenges = query(collection(db, 'challenges'), where('status', '==', 'نشط'));
    publicUnsubs.push(
      onSnapshot(
        qChallenges,
        (snap) => {
          if (!syncStateRef || isFirebaseAdminUser(auth.currentUser)) return;
          syncStateRef.challenges = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
          triggerHydrate();
        },
        (err) => {
          handleFirestoreError(err, OperationType.LIST, 'challenges');
        }
      )
    );
  } catch (err) {
    console.warn('Could not attach challenges listener:', err);
  }
}

function attachAdminListeners() {
  clearSubs(publicUnsubs);
  clearSubs(activeUnsubs);

  const subscribeAdminCol = (colName: string, handler: (docs: any[]) => void) => {
    const unsub = onSnapshot(
      collection(db, colName),
      (snap) => {
        const items = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
        handler(items);
        triggerHydrate();
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, colName);
      }
    );
    activeUnsubs.push(unsub);
  };

  subscribeAdminCol('students', (items) => {
    if (!syncStateRef) return;
    syncStateRef.students = items;
  });

  // Merge mentors_public and mentors (private PII) so admin has complete fields + email/idProof
  let latestPublicMentors: any[] = [];
  let latestPrivateMentors: any[] = [];
  const mergeMentorsForAdmin = () => {
    if (!syncStateRef) return;
    syncStateRef.mentors = mergeById(latestPublicMentors, latestPrivateMentors, true);
  };

  subscribeAdminCol('mentors_public', (items) => {
    latestPublicMentors = items;
    mergeMentorsForAdmin();
  });

  subscribeAdminCol('mentors', (items) => {
    latestPrivateMentors = items.map((m) => ({
      ...m,
      idProof: m.idProofRef || m.idProof || '',
      syndicateCard: m.syndicateCardRef || m.syndicateCard || ''
    }));
    mergeMentorsForAdmin();
  });

  subscribeAdminCol('companies', (items) => {
    if (!syncStateRef) return;
    syncStateRef.companies = items;
  });

  subscribeAdminCol('verifications', (items) => {
    if (!syncStateRef) return;
    syncStateRef.verifications = items;
  });

  subscribeAdminCol('jobs', (items) => {
    if (!syncStateRef) return;
    syncStateRef.jobs = items;
  });

  subscribeAdminCol('applications', (items) => {
    if (!syncStateRef) return;
    syncStateRef.applications = items;
  });

  subscribeAdminCol('challenges', (items) => {
    if (!syncStateRef) return;
    syncStateRef.challenges = items;
  });

  subscribeAdminCol('submissions', (items) => {
    if (!syncStateRef) return;
    syncStateRef.submissions = items;
  });

  subscribeAdminCol('bookings', (items) => {
    if (!syncStateRef) return;
    syncStateRef.bookings = items;
  });

  subscribeAdminCol('reports', (items) => {
    if (!syncStateRef) return;
    syncStateRef.reports = items;
  });

  subscribeAdminCol('blacklist_ips', (items) => {
    if (!syncStateRef) return;
    syncStateRef.blacklistIps = items;
  });

  subscribeAdminCol('portfolio_items', (items) => {
    if (!syncPortfolioRef) return;
    syncPortfolioRef.items = items;
  });
}

function attachOwnerListeners(user: User) {
  clearSubs(activeUnsubs);
  const uid = user.uid;

  // User account doc
  activeUnsubs.push(
    onSnapshot(
      doc(db, 'users', uid),
      (snap) => {
        if (!syncStateRef || !snap.exists()) return;
        const uData = snap.data();
        if (!syncStateRef.currentUser || syncStateRef.currentUser.uid === uid) {
          syncStateRef.currentUser = {
            ...(syncStateRef.currentUser || {}),
            id: uData.profileId || uid,
            uid,
            role: uData.role,
            name: uData.name,
            email: uData.email,
            phone: uData.phone || syncStateRef.currentUser?.phone || '',
            status: uData.status,
            joinedAt: uData.joinedAt || ''
          };
          triggerHydrate();
        }
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, `users/${uid}`);
      }
    )
  );

  // Own student record
  activeUnsubs.push(
    onSnapshot(
      query(collection(db, 'students'), where('ownerUid', '==', uid)),
      (snap) => {
        if (!syncStateRef) return;
        const items = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
        if (items.length > 0) {
          syncStateRef.students = mergeById(syncStateRef.students || [], items, true);
          const mine: any = items[0];
          if (!syncStateRef.currentUser || syncStateRef.currentUser.role === 'student') {
            syncStateRef.currentUser = {
              ...(syncStateRef.currentUser || {}),
              id: mine.id,
              uid,
              role: 'student',
              name: mine.name,
              email: mine.email,
              phone: mine.phone || syncStateRef.currentUser?.phone || '',
              university: mine.university,
              department: mine.department,
              gradYear: mine.gradYear,
              status: mine.status,
              joinedAt: mine.joinedAt
            };
          }
          if (mine.timaStats) {
            syncStateRef.timaCard.stats = { ...syncStateRef.timaCard.stats, ...mine.timaStats };
          }
          if (mine.overall !== undefined) syncStateRef.timaCard.overall = mine.overall;
          if (mine.totalPoints !== undefined) syncStateRef.totalPoints = mine.totalPoints;
          if (mine.name) syncStateRef.timaCard.name = mine.name;
          if (mine.department) syncStateRef.timaCard.department = mine.department;
          if (mine.gradYear) syncStateRef.timaCard.gradYear = mine.gradYear;
          triggerHydrate();
        }
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'students')
    )
  );

  // Active Students Talent Directory (Public, No PII)
  activeUnsubs.push(
    onSnapshot(
      query(collection(db, 'students_public'), where('status', '==', 'active')),
      (snap) => {
        if (!syncStateRef) return;
        const pub = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
        syncStateRef.students = mergeById(syncStateRef.students || [], pub, false);
        triggerHydrate();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'students_public')
    )
  );

  // Own mentor private record
  activeUnsubs.push(
    onSnapshot(
      query(collection(db, 'mentors'), where('ownerUid', '==', uid)),
      (snap) => {
        if (!syncStateRef) return;
        const items = snap.docs.map((d) => ({
          ...d.data(),
          id: d.id,
          idProof: d.data().idProofRef || '',
          syndicateCard: d.data().syndicateCardRef || ''
        }));
        if (items.length > 0) {
          syncStateRef.mentors = mergeById(syncStateRef.mentors || [], items, true);
          const mine: any = items[0];
          if (!syncStateRef.currentUser || syncStateRef.currentUser.role === 'mentor') {
            syncStateRef.currentUser = {
              ...(syncStateRef.currentUser || {}),
              ...mine,
              id: mine.id,
              uid,
              role: 'mentor'
            };
          }
          triggerHydrate();
        }
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'mentors')
    )
  );

  // Own company record
  activeUnsubs.push(
    onSnapshot(
      query(collection(db, 'companies'), where('ownerUid', '==', uid)),
      (snap) => {
        if (!syncStateRef) return;
        const items = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
        if (items.length > 0) {
          syncStateRef.companies = mergeById(syncStateRef.companies || [], items, true);
          const mine: any = items[0];
          if (!syncStateRef.currentUser || syncStateRef.currentUser.role === 'company') {
            syncStateRef.currentUser = {
              ...(syncStateRef.currentUser || {}),
              ...mine,
              id: mine.id,
              uid,
              role: 'company'
            };
          }
          triggerHydrate();
        }
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'companies')
    )
  );

  // Own verifications
  activeUnsubs.push(
    onSnapshot(
      query(collection(db, 'verifications'), where('ownerUid', '==', uid)),
      (snap) => {
        if (!syncStateRef) return;
        const items = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
        syncStateRef.verifications = mergeById(syncStateRef.verifications || [], items, true);
        triggerHydrate();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'verifications')
    )
  );

  // Own bookings as student
  activeUnsubs.push(
    onSnapshot(
      query(collection(db, 'bookings'), where('ownerUid', '==', uid)),
      (snap) => {
        if (!syncStateRef) return;
        const items = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
        syncStateRef.bookings = mergeById(syncStateRef.bookings || [], items, true);
        triggerHydrate();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'bookings')
    )
  );

  // Own bookings as mentor
  activeUnsubs.push(
    onSnapshot(
      query(collection(db, 'bookings'), where('mentorOwnerUid', '==', uid)),
      (snap) => {
        if (!syncStateRef) return;
        const items = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
        syncStateRef.bookings = mergeById(syncStateRef.bookings || [], items, true);
        triggerHydrate();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'bookings')
    )
  );

  // Own submissions
  activeUnsubs.push(
    onSnapshot(
      query(collection(db, 'submissions'), where('ownerUid', '==', uid)),
      (snap) => {
        if (!syncStateRef) return;
        const items = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
        syncStateRef.submissions = mergeById(syncStateRef.submissions || [], items, true);
        triggerHydrate();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'submissions')
    )
  );

  // Own applications
  activeUnsubs.push(
    onSnapshot(
      query(collection(db, 'applications'), where('ownerUid', '==', uid)),
      (snap) => {
        if (!syncStateRef) return;
        const items = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
        syncStateRef.applications = mergeById(syncStateRef.applications || [], items, true);
        triggerHydrate();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'applications')
    )
  );

  // Own portfolio items
  activeUnsubs.push(
    onSnapshot(
      query(collection(db, 'portfolio_items'), where('ownerUid', '==', uid)),
      (snap) => {
        if (!syncPortfolioRef) return;
        const items = snap.docs.map((d) => normalizePortfolioDoc({ ...d.data(), id: d.id }));
        syncPortfolioRef.items = mergeById(syncPortfolioRef.items || [], items, true);
        triggerHydrate();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'portfolio_items')
    )
  );

  // Own CV document keyed by UID under users/{uid}/cv/main
  activeUnsubs.push(
    onSnapshot(
      doc(db, 'users', uid, 'cv', 'main'),
      (snap) => {
        if (!syncCvStateRef || !snap.exists()) return;
        if (localStorage.getItem(GUEST_PENDING_CV_KEY) === '1') return;
        const remoteCV = snap.data();
        syncCvStateRef.data = {
          ...(syncCvStateRef.data || {}),
          ...remoteCV,
          education: {
            ...(syncCvStateRef.data?.education || {}),
            ...(remoteCV?.education || {})
          }
        };
        try {
          localStorage.setItem(`tima_cv_${uid}`, JSON.stringify(syncCvStateRef.data));
        } catch (_) {}
        triggerHydrate();
      },
      (err) => handleFirestoreError(err, OperationType.GET, `users/${uid}/cv/main`)
    )
  );
}

export function initFirebaseBridge(state: any, portfolioState: any, onHydrate: () => void, cvState?: any) {
  syncStateRef = state;
  syncPortfolioRef = portfolioState;
  if (cvState) syncCvStateRef = cvState;
  onHydrateRef = onHydrate;

  if (bootInitialized) return;
  bootInitialized = true;

  // Validate Firestore connection on initial boot
  testConnection();

  // Always listen to public non-PII catalogs (mentors_public, jobs, challenges)
  attachPublicListeners();

  // Attach user/admin listeners strictly when Firebase Auth state resolves
  subscribeAuthState((user) => {
    clearSubs(activeUnsubs);
    if (!user || !user.emailVerified) {
      attachPublicListeners();
      triggerHydrate();
      return;
    }

    if (isFirebaseAdminUser(user)) {
      // Ensure admin view knows this Google account is verified super-admin
      if (syncStateRef) {
        sessionStorage.setItem('phi_admin_authenticated', 'true');
        localStorage.setItem('phi_admin_authenticated', 'true');
        if (!syncStateRef.currentUser || syncStateRef.currentUser.role === 'admin') {
          syncStateRef.currentUser = {
            id: 'admin-super',
            uid: user.uid,
            role: 'admin',
            name: user.displayName || 'المدير العام φ To Media',
            email: user.email || '34256abd@gmail.com',
            status: 'active',
            joinedAt: new Date().toLocaleDateString('ar-EG')
          };
        }
      }
      attachAdminListeners();
    } else {
      attachPublicListeners();
      attachOwnerListeners(user);
      migrateGuestLocalDataToCloud(user).catch((err) => {
        console.warn('Background guest-to-cloud migration notice:', err);
      });
    }
    triggerHydrate();
  });
}

let migrationLockUid: string | null = null;

export async function migrateGuestLocalDataToCloud(user: User): Promise<{
  migratedCount: number;
  migratedTypes: string[];
}> {
  if (!user || !user.uid || !user.emailVerified) {
    return { migratedCount: 0, migratedTypes: [] };
  }
  const uid = sanitizeId(user.uid, 'uid');
  if (migrationLockUid === uid) {
    return { migratedCount: 0, migratedTypes: [] };
  }
  migrationLockUid = uid;
  let migratedCount = 0;
  const migratedTypes: string[] = [];

  try {
    // 1. Migrate pending Guest CV -> users/{uid}/cv/main
    try {
      const guestCvKey = 'tima_cv_guest_student@phitomedia.eg';
      const guestCvRaw = localStorage.getItem(guestCvKey);
      const isCvPending = localStorage.getItem(GUEST_PENDING_CV_KEY) === '1';
      let candidateCv: any = null;

      if (guestCvRaw) {
        try {
          candidateCv = JSON.parse(guestCvRaw);
        } catch (_) {}
      }
      if (!hasMeaningfulCVData(candidateCv) && isCvPending && syncCvStateRef?.data) {
        candidateCv = syncCvStateRef.data;
      }

      if ((isCvPending || guestCvRaw) && hasMeaningfulCVData(candidateCv)) {
        const synced = await syncUserCVToCloud(candidateCv, user);
        if (synced) {
          localStorage.setItem(`tima_cv_${uid}`, JSON.stringify(candidateCv));
          localStorage.removeItem(guestCvKey);
          localStorage.removeItem(GUEST_PENDING_CV_KEY);
          if (syncCvStateRef) {
            syncCvStateRef.data = candidateCv;
          }
          migratedCount += 1;
          migratedTypes.push('cv');
        }
      } else if (isCvPending) {
        localStorage.removeItem(GUEST_PENDING_CV_KEY);
      }
    } catch (err) {
      console.warn('Guest CV migration error:', err);
    }

    // 2. Migrate pending Guest Portfolio -> portfolio_items
    try {
      const guestPortKey = 'tima_portfolio_guest_student@phitomedia.eg';
      const guestPortRaw = localStorage.getItem(guestPortKey);
      const isPortPending = localStorage.getItem(GUEST_PENDING_PORTFOLIO_KEY) === '1';
      let candidateItems: any[] = [];

      if (guestPortRaw) {
        try {
          const parsed = JSON.parse(guestPortRaw);
          if (Array.isArray(parsed)) candidateItems = parsed;
        } catch (_) {}
      }
      if (candidateItems.length === 0 && isPortPending && Array.isArray(syncPortfolioRef?.items)) {
        candidateItems = syncPortfolioRef.items;
      }

      if ((isPortPending || guestPortRaw) && candidateItems.length > 0) {
        let portSynced = 0;
        for (const item of candidateItems) {
          if (!item || !item.id || !item.title) continue;
          const ok = await syncPortfolioItemCreateToCloud(
            {
              ...item,
              studentName: user.displayName || item.studentName || 'طالب إعلام'
            },
            user
          );
          if (ok) portSynced += 1;
        }
        if (portSynced > 0) {
          const existingUidRaw = localStorage.getItem(`tima_portfolio_${uid}`);
          const existingUidList = existingUidRaw ? JSON.parse(existingUidRaw) : [];
          const mergedPort = mergeById(
            Array.isArray(existingUidList) ? existingUidList : [],
            candidateItems,
            false
          );
          localStorage.setItem(`tima_portfolio_${uid}`, JSON.stringify(mergedPort));
          localStorage.removeItem(guestPortKey);
          localStorage.removeItem(GUEST_PENDING_PORTFOLIO_KEY);
          migratedCount += portSynced;
          migratedTypes.push('portfolio');
        }
      } else if (isPortPending) {
        localStorage.removeItem(GUEST_PENDING_PORTFOLIO_KEY);
      }
    } catch (err) {
      console.warn('Guest portfolio migration error:', err);
    }

    // 3. Migrate pending Student Progress / Theme (requires existing students record owned by UID)
    try {
      const progRaw = localStorage.getItem(GUEST_PENDING_PROGRESS_KEY);
      if (progRaw) {
        const sSnap = await getDocs(query(collection(db, 'students'), where('ownerUid', '==', uid)));
        if (!sSnap.empty) {
          const mine = sSnap.docs[0];
          let parsedProg: any = {};
          try {
            parsedProg = progRaw === '1' ? {} : JSON.parse(progRaw);
          } catch (_) {
            parsedProg = {};
          }
          const ok = await syncStudentProgressToCloud(
            mine.id,
            {
              overall: parsedProg.overall ?? syncStateRef?.timaCard?.overall,
              timaStats: parsedProg.timaStats ?? syncStateRef?.timaCard?.stats,
              totalPoints: parsedProg.totalPoints ?? syncStateRef?.totalPoints,
              works: parsedProg.works ?? syncPortfolioRef?.items?.length,
              customTheme: parsedProg.customTheme ?? syncStateRef?.customTheme
            },
            user
          );
          if (ok) {
            localStorage.removeItem(GUEST_PENDING_PROGRESS_KEY);
            migratedCount += 1;
            migratedTypes.push('progress');
          }
        }
      }
    } catch (err) {
      console.warn('Guest progress migration error:', err);
    }

    // 4. Migrate pending queue items (Ratings, Submissions, Bookings, Applications, Jobs, Reports)
    const flushQueue = async (
      storageKey: string,
      typeLabel: string,
      worker: (entry: any) => Promise<boolean>
    ) => {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      let items: any[] = [];
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) items = parsed;
      } catch (_) {}
      if (items.length === 0) {
        localStorage.removeItem(storageKey);
        return;
      }
      const remaining: any[] = [];
      let doneHere = 0;
      for (const entry of items) {
        try {
          const ok = await worker(entry);
          if (ok) {
            doneHere += 1;
          } else {
            remaining.push(entry);
          }
        } catch (_) {
          remaining.push(entry);
        }
      }
      if (remaining.length > 0) {
        localStorage.setItem(storageKey, JSON.stringify(remaining));
      } else {
        localStorage.removeItem(storageKey);
      }
      if (doneHere > 0) {
        migratedCount += doneHere;
        migratedTypes.push(typeLabel);
      }
    };

    await flushQueue(GUEST_PENDING_RATINGS_KEY, 'ratings', async (entry) =>
      syncBookingRatingToCloud(
        entry.bookingId,
        entry.mentorId,
        entry.rating,
        entry.comment,
        entry.newAvgRating,
        entry.reviewsList,
        entry.sessionsCount,
        user
      )
    );

    await flushQueue(GUEST_PENDING_SUBMISSIONS_KEY, 'submissions', async (entry) =>
      syncSubmissionCreateToCloud(entry.sub, entry.challengeSubmissionsCount, user)
    );

    await flushQueue(GUEST_PENDING_BOOKINGS_KEY, 'bookings', async (entry) =>
      syncBookingCreateToCloud(entry, user)
    );

    await flushQueue(GUEST_PENDING_APPS_KEY, 'applications', async (entry) =>
      syncApplicationCreateToCloud(entry.appItem, entry.newApplicantsCount, user)
    );

    await flushQueue(GUEST_PENDING_JOBS_KEY, 'jobs', async (entry) =>
      syncJobCreateToCloud(entry, user)
    );

    await flushQueue(GUEST_PENDING_REPORTS_KEY, 'reports', async (entry) =>
      syncReportCreateToCloud(entry, user)
    );

    return { migratedCount, migratedTypes };
  } finally {
    if (migrationLockUid === uid) {
      migrationLockUid = null;
    }
  }
}

export async function hydrateUserWorkspaceFromCloud(user: User): Promise<{
  foundProfile: boolean;
  role: string | null;
  fallbackUsed: boolean;
  migratedCount: number;
  migratedTypes: string[];
}> {
  if (!user || !user.uid) {
    return { foundProfile: false, role: null, fallbackUsed: true, migratedCount: 0, migratedTypes: [] };
  }
  const uid = sanitizeId(user.uid, 'uid');
  let foundProfile = false;
  let detectedRole: string | null = null;
  let migratedCount = 0;
  let migratedTypes: string[] = [];

  try {
    // 0. Auto-migrate any local guest data created prior to signing in
    try {
      const migRes = await migrateGuestLocalDataToCloud(user);
      migratedCount = migRes.migratedCount;
      migratedTypes = migRes.migratedTypes;
    } catch (migErr) {
      console.warn('Pre-hydration guest migration warning:', migErr);
    }

    // 1. Load user account identity
    const userSnap = await getDoc(doc(db, 'users', uid));
    if (userSnap.exists() && syncStateRef) {
      const uData = userSnap.data();
      detectedRole = uData.role || null;
      foundProfile = true;
      syncStateRef.currentUser = {
        ...(syncStateRef.currentUser || {}),
        id: uData.profileId || uid,
        uid,
        role: uData.role,
        name: uData.name || user.displayName || '',
        email: uData.email || user.email || '',
        phone: uData.phone || '',
        status: uData.status || 'active',
        joinedAt: uData.joinedAt || ''
      };
    }

    // 2. Hydrate role-specific profile by ownerUid
    if (syncStateRef && (!detectedRole || detectedRole === 'student')) {
      const sSnap = await getDocs(query(collection(db, 'students'), where('ownerUid', '==', uid)));
      if (!sSnap.empty) {
        const items = sSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
        const mine: any = items[0];
        foundProfile = true;
        detectedRole = 'student';
        syncStateRef.students = mergeById(syncStateRef.students || [], items, true);
        syncStateRef.currentUser = {
          ...(syncStateRef.currentUser || {}),
          id: mine.id,
          uid,
          role: 'student',
          name: mine.name,
          email: mine.email,
          phone: mine.phone || syncStateRef.currentUser?.phone || '',
          university: mine.university,
          department: mine.department,
          gradYear: mine.gradYear,
          status: mine.status,
          joinedAt: mine.joinedAt
        };
        if (mine.timaStats) {
          syncStateRef.timaCard.stats = { ...syncStateRef.timaCard.stats, ...mine.timaStats };
        }
        if (mine.overall !== undefined) syncStateRef.timaCard.overall = mine.overall;
        if (mine.totalPoints !== undefined) syncStateRef.totalPoints = mine.totalPoints;
        if (mine.name) syncStateRef.timaCard.name = mine.name;
        if (mine.department) syncStateRef.timaCard.department = mine.department;
        if (mine.gradYear) syncStateRef.timaCard.gradYear = mine.gradYear;
      }
    }

    if (syncStateRef && (!detectedRole || detectedRole === 'mentor')) {
      const mSnap = await getDocs(query(collection(db, 'mentors'), where('ownerUid', '==', uid)));
      if (!mSnap.empty) {
        const items = mSnap.docs.map((d) => ({
          ...d.data(),
          id: d.id,
          idProof: d.data().idProofRef || '',
          syndicateCard: d.data().syndicateCardRef || ''
        }));
        const mine: any = items[0];
        foundProfile = true;
        detectedRole = 'mentor';
        syncStateRef.mentors = mergeById(syncStateRef.mentors || [], items, true);
        syncStateRef.currentUser = {
          ...(syncStateRef.currentUser || {}),
          ...mine,
          id: mine.id,
          uid,
          role: 'mentor'
        };
      }
    }

    if (syncStateRef && (!detectedRole || detectedRole === 'company')) {
      const cSnap = await getDocs(query(collection(db, 'companies'), where('ownerUid', '==', uid)));
      if (!cSnap.empty) {
        const items = cSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
        const mine: any = items[0];
        foundProfile = true;
        detectedRole = 'company';
        syncStateRef.companies = mergeById(syncStateRef.companies || [], items, true);
        syncStateRef.currentUser = {
          ...(syncStateRef.currentUser || {}),
          ...mine,
          id: mine.id,
          uid,
          role: 'company'
        };
      }
    }

    // 3. Hydrate CV keyed by UID under users/{uid}/cv/main (with legacy fallback)
    if (syncCvStateRef) {
      let cvSnap = await getDoc(doc(db, 'users', uid, 'cv', 'main'));
      if (!cvSnap.exists()) {
        cvSnap = await getDoc(doc(db, 'user_cvs', uid));
      }
      if (cvSnap.exists()) {
        const remoteCV = cvSnap.data();
        syncCvStateRef.data = {
          ...(syncCvStateRef.data || {}),
          ...remoteCV,
          education: {
            ...(syncCvStateRef.data?.education || {}),
            ...(remoteCV?.education || {})
          }
        };
        try {
          localStorage.setItem(`tima_cv_${uid}`, JSON.stringify(syncCvStateRef.data));
        } catch (_) {}
      }
    }

    // 4. Hydrate Portfolio items owned by UID
    if (syncPortfolioRef) {
      const portSnap = await getDocs(query(collection(db, 'portfolio_items'), where('ownerUid', '==', uid)));
      const items = portSnap.docs.map((d) => normalizePortfolioDoc({ ...d.data(), id: d.id }));
      if (items.length > 0) {
        syncPortfolioRef.items = mergeById(syncPortfolioRef.items || [], items, true);
        try {
          localStorage.setItem(`tima_portfolio_${uid}`, JSON.stringify(syncPortfolioRef.items));
        } catch (_) {}
      }
    }

    triggerHydrate();
    return { foundProfile, role: detectedRole, fallbackUsed: false, migratedCount, migratedTypes };
  } catch (err) {
    console.warn('Firestore workspace hydration failed; using offline local cache fallback:', err);
    return {
      foundProfile: Boolean(syncStateRef?.currentUser && syncStateRef.currentUser.uid === uid),
      role: syncStateRef?.currentUser?.role || null,
      fallbackUsed: true,
      migratedCount,
      migratedTypes
    };
  }
}

export async function syncUserCVToCloud(cvData: any, userOverride?: User | null): Promise<boolean> {
  const user = userOverride || (await getCurrentAuthUser());
  if (!user || !user.emailVerified) return false;
  const uid = sanitizeId(user.uid, 'uid');
  const ref = doc(db, 'users', uid, 'cv', 'main');
  const cleanPayload = sanitizeUserCVData(cvData, uid);

  try {
    const existingSnap = await getDoc(ref);
    if (existingSnap.exists()) {
      await setDoc(ref, {
        ...cleanPayload,
        createdAt: existingSnap.data()?.createdAt || serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    } else {
      await setDoc(ref, {
        ...cleanPayload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `users/${uid}/cv/main`);
  }
}

export async function getUserCVFromCloud(uidOverride?: string): Promise<any | null> {
  const user = await getCurrentAuthUser();
  const uid = sanitizeId(uidOverride || user?.uid || '', 'uid');
  if (!user || !uid) return null;
  try {
    const subSnap = await getDoc(doc(db, 'users', uid, 'cv', 'main'));
    if (subSnap.exists()) return subSnap.data();
    const legacySnap = await getDoc(doc(db, 'user_cvs', uid));
    return legacySnap.exists() ? legacySnap.data() : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `users/${uid}/cv/main`);
  }
}

export async function getPortfolioItemsFromCloud(uidOverride?: string): Promise<any[]> {
  const user = await getCurrentAuthUser();
  const uid = sanitizeId(uidOverride || user?.uid || '', 'uid');
  if (!user || !uid) return [];
  try {
    const snap = await getDocs(query(collection(db, 'portfolio_items'), where('ownerUid', '==', uid)));
    return snap.docs.map((d) => normalizePortfolioDoc({ ...d.data(), id: d.id }));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'portfolio_items');
  }
}

// -------------------------------------------------------------
// FIRESTORE SYNC MUTATION HELPERS (Strictly Validated & Clamped)
// -------------------------------------------------------------

export async function syncStudentRegistrationToCloud(student: any, totalPoints = 0) {
  const user = await ensureGoogleAuth();
  const uid = sanitizeId(user.uid, 'uid');
  const studentId = sanitizeId(student.id, 'stud');
  const joinedAt = clampStr(student.joinedAt, 64, new Date().toLocaleDateString('ar-EG'));
  const email = clampStr(student.email || user.email, 160);
  const name = clampStr(student.name || user.displayName, 120, 'طالب إعلام');

  const batch = writeBatch(db);

  batch.set(doc(db, 'users', uid), {
    uid,
    profileId: studentId,
    role: 'student',
    name,
    email,
    phone: clampStr(student.phone, 32),
    status: 'active',
    joinedAt,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  batch.set(doc(db, 'students', studentId), {
    id: studentId,
    ownerUid: uid,
    name,
    email,
    phone: clampStr(student.phone, 32),
    position: clampStr(student.position, 120, 'طالب إعلام'),
    university: clampStr(student.university, 160, 'جامعة القاهرة'),
    department: clampStr(student.department, 120, 'إذاعة وتلفزيون'),
    gradYear: clampStr(student.gradYear, 16, '2027'),
    overall: clampNum(student.overall, 0, 100, 0),
    timaStats: student.timaStats || {},
    totalPoints: clampNum(totalPoints, 0, 10000000, 0),
    prestigeCount: 0,
    customTheme: 'cosmic',
    works: clampNum(student.works, 0, 10000, 0),
    status: 'active',
    joinedAt,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  batch.set(doc(db, 'students_public', studentId), {
    id: studentId,
    ownerUid: uid,
    name,
    position: clampStr(student.position, 120, 'طالب إعلام'),
    university: clampStr(student.university, 160, 'جامعة القاهرة'),
    department: clampStr(student.department, 120, 'إذاعة وتلفزيون'),
    gradYear: clampStr(student.gradYear, 16, '2027'),
    overall: clampNum(student.overall, 0, 100, 0),
    timaStats: student.timaStats || {},
    works: clampNum(student.works, 0, 10000, 0),
    status: 'active',
    joinedAt,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  try {
    await batch.commit();
    localStorage.removeItem(GUEST_PENDING_PROGRESS_KEY);
    migrateGuestLocalDataToCloud(user).catch(() => {});
    return uid;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `students/${studentId}`);
  }
}

export async function syncAdminAddedStudentToCloud(student: any) {
  const user = auth.currentUser;
  if (!user || !isFirebaseAdminUser(user)) return;
  const studentId = sanitizeId(student.id, 'stud');
  const ownerUid = sanitizeId(user.uid, 'admin');
  const joinedAt = clampStr(student.joinedAt, 64, new Date().toLocaleDateString('ar-EG'));
  const batch = writeBatch(db);

  batch.set(doc(db, 'students', studentId), {
    id: studentId,
    ownerUid,
    name: clampStr(student.name, 120, 'طالب إعلام'),
    email: clampStr(student.email, 160),
    position: clampStr(student.position, 120, 'طالب إعلام'),
    university: clampStr(student.university, 160, 'جامعة القاهرة'),
    department: clampStr(student.department, 120, 'إذاعة وتلفزيون'),
    gradYear: clampStr(student.gradYear, 16, '2027'),
    overall: clampNum(student.overall, 0, 100, 90),
    timaStats: student.timaStats || {},
    totalPoints: 0,
    prestigeCount: 0,
    customTheme: 'cosmic',
    works: clampNum(student.works, 0, 10000, 1),
    status: 'active',
    joinedAt,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  batch.set(doc(db, 'students_public', studentId), {
    id: studentId,
    ownerUid,
    name: clampStr(student.name, 120, 'طالب إعلام'),
    position: clampStr(student.position, 120, 'طالب إعلام'),
    university: clampStr(student.university, 160, 'جامعة القاهرة'),
    department: clampStr(student.department, 120, 'إذاعة وتلفزيون'),
    gradYear: clampStr(student.gradYear, 16, '2027'),
    overall: clampNum(student.overall, 0, 100, 90),
    timaStats: student.timaStats || {},
    works: clampNum(student.works, 0, 10000, 1),
    status: 'active',
    joinedAt,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `students/${studentId}`);
  }
}

export async function syncStudentProgressToCloud(
  studentId: string,
  patch: any,
  userOverride?: User | null
): Promise<boolean> {
  const user = userOverride || (await getCurrentAuthUser());
  if (!user || !user.emailVerified || !studentId) return false;
  const sid = sanitizeId(studentId, 'stud');

  try {
    const ref = doc(db, 'students', sid);
    const snap = await getDoc(ref);
    if (!snap.exists()) return false;

    const allowedPrivate: Record<string, any> = { updatedAt: serverTimestamp() };
    const allowedPublic: Record<string, any> = { updatedAt: serverTimestamp() };

    if (patch.overall !== undefined) {
      const ovr = clampNum(patch.overall, 0, 100, 0);
      allowedPrivate.overall = ovr;
      allowedPublic.overall = ovr;
    }
    if (patch.timaStats) {
      allowedPrivate.timaStats = patch.timaStats;
      allowedPublic.timaStats = patch.timaStats;
    }
    if (patch.totalPoints !== undefined) {
      allowedPrivate.totalPoints = clampNum(patch.totalPoints, 0, 10000000, 0);
    }
    if (patch.works !== undefined) {
      const w = clampNum(patch.works, 0, 10000, 0);
      allowedPrivate.works = w;
      allowedPublic.works = w;
    }
    if (patch.customTheme !== undefined) {
      allowedPrivate.customTheme = clampStr(patch.customTheme, 40, 'cosmic');
    }

    const batch = writeBatch(db);
    batch.update(ref, allowedPrivate);
    batch.update(doc(db, 'students_public', sid), allowedPublic);
    await batch.commit();
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `students/${sid}`);
  }
}

export async function syncMentorRegistrationToCloud(mentor: any, verif: any) {
  const user = await ensureGoogleAuth();
  const uid = sanitizeId(user.uid, 'uid');
  const mentorId = sanitizeId(mentor.id, 'mentor');
  const verifId = sanitizeId(verif?.id || `verif-${mentorId}`, 'verif');
  const joinedAt = clampStr(mentor.joinedAt, 64, new Date().toLocaleDateString('ar-EG'));
  const email = clampStr(mentor.email || user.email, 160);
  const name = clampStr(mentor.name || user.displayName, 120, 'خبير إعلامي');
  const fullName = clampStr(mentor.fullName || name, 120);
  const specialty = clampStr(mentor.specialty, 160, 'استشارات إعلامية');
  const price = clampNum(mentor.price, 0, 100000, 200);
  const payoutMethod = ['instapay', 'wallet', 'bank', 'fawry'].includes(mentor.payoutMethod)
    ? mentor.payoutMethod
    : 'instapay';
  const acceptedMethods = Array.isArray(mentor.accepted_methods)
    ? mentor.accepted_methods.slice(0, 10).map((x: unknown) => clampStr(x, 30))
    : [payoutMethod];

  const idProofRef = clampMediaRef(mentor.idProof, 150000);
  const syndicateCardRef = clampMediaRef(mentor.syndicateCard, 150000);

  const batch = writeBatch(db);

  batch.set(doc(db, 'users', uid), {
    uid,
    profileId: mentorId,
    role: 'mentor',
    name,
    email,
    status: 'pending_verification',
    joinedAt,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  batch.set(doc(db, 'mentors_public', mentorId), {
    id: mentorId,
    ownerUid: uid,
    name,
    fullName,
    specialty,
    workplace: clampStr(mentor.workplace, 160),
    experience: clampStr(mentor.experience, 240),
    yearsExp: clampNum(mentor.yearsExp, 0, 80, 1),
    portfolioLink: clampStr(mentor.portfolioLink || mentor.link, 500),
    rating: clampStr(mentor.rating, 10, '5.0'),
    price,
    badge: clampStr(mentor.badge || specialty, 32),
    image: clampStr(mentor.image, 500),
    bio: clampStr(mentor.bio, 600),
    meetLink: clampStr(mentor.meetLink, 300, 'https://meet.google.com/phi-mentor-direct'),
    payoutMethod,
    instapay_link: clampStr(mentor.instapay_link, 160),
    accepted_methods: acceptedMethods,
    reviewsList: [],
    sessionsCount: 0,
    status: 'pending_verification',
    verificationStatus: 'pending_verification',
    isVerified: false,
    joinedAt,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  batch.set(doc(db, 'mentors', mentorId), {
    id: mentorId,
    ownerUid: uid,
    name,
    fullName,
    email,
    specialty,
    workplace: clampStr(mentor.workplace, 160),
    experience: clampStr(mentor.experience, 240),
    yearsExp: clampNum(mentor.yearsExp, 0, 80, 1),
    price,
    portfolioLink: clampStr(mentor.portfolioLink || mentor.link, 500),
    payoutMethod,
    instapay_link: clampStr(mentor.instapay_link, 160),
    instapay_phone: clampStr(mentor.instapay_phone, 32),
    wallet_phone: clampStr(mentor.wallet_phone, 32),
    wallet_provider: clampStr(mentor.wallet_provider, 80),
    bank_name: clampStr(mentor.bank_name, 120),
    bank_iban: clampStr(mentor.bank_iban, 64),
    bank_holder: clampStr(mentor.bank_holder, 120),
    fawry_phone: clampStr(mentor.fawry_phone, 32),
    accepted_methods: acceptedMethods,
    idProofRef,
    syndicateCardRef,
    status: 'pending_verification',
    verificationStatus: 'pending_verification',
    isVerified: false,
    earnings: 0,
    sessionsCount: 0,
    joinedAt,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  batch.set(doc(db, 'verifications', verifId), {
    id: verifId,
    ownerUid: uid,
    userId: mentorId,
    name: fullName,
    role: 'mentor',
    specialty,
    email,
    workplace: clampStr(mentor.workplace, 160),
    portfolioLink: clampStr(mentor.portfolioLink || mentor.link, 500),
    payoutMethod,
    idProof: idProofRef,
    syndicateCard: syndicateCardRef,
    date: joinedAt,
    status: 'pending',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  try {
    await batch.commit();
    migrateGuestLocalDataToCloud(user).catch(() => {});
    return uid;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `mentors/${mentorId}`);
  }
}

export async function syncCompanyRegistrationToCloud(company: any, verif: any) {
  const user = await ensureGoogleAuth();
  const uid = sanitizeId(user.uid, 'uid');
  const compId = sanitizeId(company.id, 'comp');
  const verifId = sanitizeId(verif?.id || `verif-${compId}`, 'verif');
  const joinedAt = clampStr(company.joinedAt, 64, new Date().toLocaleDateString('ar-EG'));
  const email = clampStr(company.email || user.email, 160);
  const name = clampStr(company.name, 160, 'مؤسسة إعلامية');
  const commercialRegister = clampMediaRef(company.commercialRegister, 150000);

  const batch = writeBatch(db);

  batch.set(doc(db, 'users', uid), {
    uid,
    profileId: compId,
    role: 'company',
    name,
    email,
    phone: clampStr(company.phone, 32),
    status: 'pending_verification',
    joinedAt,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  batch.set(doc(db, 'companies', compId), {
    id: compId,
    ownerUid: uid,
    name,
    companyType: clampStr(company.companyType, 80, 'شركة انتاج'),
    email,
    phone: clampStr(company.phone, 32),
    website: clampStr(company.website, 300),
    needs: clampStr(company.needs, 600),
    commercialRegister,
    status: 'pending_verification',
    verificationStatus: 'pending_verification',
    isVerified: false,
    joinedAt,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  batch.set(doc(db, 'verifications', verifId), {
    id: verifId,
    ownerUid: uid,
    userId: compId,
    name,
    role: 'company',
    companyType: clampStr(company.companyType, 80, 'شركة انتاج'),
    email,
    website: clampStr(company.website, 300),
    commercialRegister,
    date: joinedAt,
    status: 'pending',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  try {
    await batch.commit();
    migrateGuestLocalDataToCloud(user).catch(() => {});
    return uid;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `companies/${compId}`);
  }
}

export async function syncAdminEntityDecisionToCloud(
  entityType: 'mentor' | 'company' | 'student',
  entityId: string,
  decision: 'verified' | 'rejected' | 'frozen' | 'active',
  verifId?: string
) {
  const user = auth.currentUser;
  if (!user || !isFirebaseAdminUser(user)) return;
  const id = sanitizeId(entityId, entityType);
  const batch = writeBatch(db);

  if (entityType === 'mentor') {
    const isVer = decision === 'verified';
    const patch = {
      status: decision,
      verificationStatus: decision === 'frozen' ? 'frozen' : decision,
      isVerified: isVer,
      updatedAt: serverTimestamp()
    };
    const privRef = doc(db, 'mentors', id);
    const pubRef = doc(db, 'mentors_public', id);
    if ((await getDoc(privRef)).exists()) batch.update(privRef, patch);
    if ((await getDoc(pubRef)).exists()) batch.update(pubRef, patch);

    if (verifId && (decision === 'verified' || decision === 'rejected')) {
      const vRef = doc(db, 'verifications', sanitizeId(verifId, 'verif'));
      if ((await getDoc(vRef)).exists()) {
        batch.update(vRef, { status: decision, updatedAt: serverTimestamp() });
      }
    }
  } else if (entityType === 'company') {
    const isVer = decision === 'verified';
    const cRef = doc(db, 'companies', id);
    if ((await getDoc(cRef)).exists()) {
      batch.update(cRef, {
        status: decision,
        verificationStatus: decision,
        isVerified: isVer,
        updatedAt: serverTimestamp()
      });
    }
    if (verifId && (decision === 'verified' || decision === 'rejected')) {
      const vRef = doc(db, 'verifications', sanitizeId(verifId, 'verif'));
      if ((await getDoc(vRef)).exists()) {
        batch.update(vRef, { status: decision, updatedAt: serverTimestamp() });
      }
    }
  } else if (entityType === 'student') {
    const sRef = doc(db, 'students', id);
    const spRef = doc(db, 'students_public', id);
    const patch = { status: decision === 'frozen' ? 'frozen' : 'active', updatedAt: serverTimestamp() };
    if ((await getDoc(sRef)).exists()) batch.update(sRef, patch);
    if ((await getDoc(spRef)).exists()) batch.update(spRef, patch);
  }

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `${entityType}/${id}`);
  }
}

export async function syncAdminDeleteEntityFromCloud(entityType: 'mentor' | 'company' | 'student', entityId: string) {
  const user = auth.currentUser;
  if (!user || !isFirebaseAdminUser(user)) return;
  const id = sanitizeId(entityId, entityType);

  try {
    const batch = writeBatch(db);
    if (entityType === 'mentor') {
      batch.delete(doc(db, 'mentors', id));
      batch.delete(doc(db, 'mentors_public', id));
      batch.delete(doc(db, 'verifications', `verif-mentor-${id}`));
    } else if (entityType === 'company') {
      batch.delete(doc(db, 'companies', id));
    } else if (entityType === 'student') {
      batch.delete(doc(db, 'students', id));
      batch.delete(doc(db, 'students_public', id));
    }
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `${entityType}/${id}`);
  }
}

export async function syncJobCreateToCloud(job: any, userOverride?: User | null): Promise<boolean> {
  const user = userOverride || (await getCurrentAuthUser());
  if (!user || !user.emailVerified) return false;
  const jobId = sanitizeId(job.id, 'job');
  try {
    await setDoc(doc(db, 'jobs', jobId), {
      id: jobId,
      ownerUid: sanitizeId(user.uid, 'uid'),
      title: clampStr(job.title, 160, 'فرصة تدريب'),
      company: clampStr(job.company, 160, 'مؤسسة إعلامية'),
      companyType: clampStr(job.companyType, 80, 'شركة انتاج'),
      type: clampStr(job.type, 40, 'تدريب'),
      minSkill: clampStr(job.minSkill, 40, 'filming'),
      minScore: clampNum(job.minScore, 0, 100, 70),
      description: clampStr(job.description, 1200),
      location: clampStr(job.location, 120, 'القاهرة'),
      stipend: clampStr(job.stipend, 120, 'مكافأة شهرية'),
      applicantsCount: clampNum(job.applicantsCount, 0, 100000, 0),
      status: 'نشط',
      date: clampStr(job.date, 64, 'الآن'),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `jobs/${jobId}`);
  }
}

export async function syncJobStatusUpdateToCloud(jobId: string, status: string) {
  const user = await getCurrentAuthUser();
  if (!user || !user.emailVerified) return false;
  const id = sanitizeId(jobId, 'job');
  try {
    const ref = doc(db, 'jobs', id);
    if ((await getDoc(ref)).exists()) {
      await updateDoc(ref, {
        status: status === 'مغلق' ? 'مغلق' : 'نشط',
        updatedAt: serverTimestamp()
      });
      return true;
    }
    return false;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `jobs/${id}`);
  }
}

export async function syncApplicationCreateToCloud(
  appItem: any,
  newApplicantsCount: number,
  userOverride?: User | null
): Promise<boolean> {
  const user = userOverride || (await getCurrentAuthUser());
  if (!user || !user.emailVerified) return false;
  const appId = sanitizeId(appItem.id, 'app');
  const jobId = sanitizeId(appItem.jobId, 'job');

  try {
    const jobRef = doc(db, 'jobs', jobId);
    const jobSnap = await getDoc(jobRef);
    if (!jobSnap.exists()) return false;

    const batch = writeBatch(db);
    batch.set(doc(db, 'applications', appId), {
      id: appId,
      ownerUid: sanitizeId(user.uid, 'uid'),
      jobId,
      jobOwnerUid: sanitizeId(jobSnap.data()?.ownerUid || user.uid, 'uid'),
      jobTitle: clampStr(appItem.jobTitle, 160),
      studentId: sanitizeId(appItem.studentId || user.uid, 'stud'),
      studentName: clampStr(appItem.studentName, 120, 'طالب إعلام'),
      university: clampStr(appItem.university, 160),
      department: clampStr(appItem.department, 120),
      timaOverall: clampNum(appItem.timaOverall, 0, 100, 0),
      skillHighlight: clampStr(appItem.skillHighlight, 80),
      status: clampStr(appItem.status, 40, 'قيد المراجعة'),
      appliedAt: clampStr(appItem.appliedAt, 64, 'الآن'),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    batch.update(jobRef, {
      applicantsCount: clampNum(newApplicantsCount, 0, 100000, 1),
      updatedAt: serverTimestamp()
    });
    await batch.commit();
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `applications/${appId}`);
  }
}

export async function syncChallengeCreateToCloud(ch: any): Promise<boolean> {
  const user = await getCurrentAuthUser();
  if (!user || !isFirebaseAdminUser(user)) return false;
  const chId = sanitizeId(ch.id, 'ch');
  try {
    await setDoc(doc(db, 'challenges', chId), {
      id: chId,
      title: clampStr(ch.title, 160),
      icon: clampStr(ch.icon, 40, 'trophy'),
      points: clampNum(ch.points, 0, 100000, 300),
      category: clampStr(ch.category, 80, 'مونتاج'),
      description: clampStr(ch.description, 1200),
      submissionsCount: clampNum(ch.submissionsCount, 0, 100000, 0),
      status: 'نشط',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `challenges/${chId}`);
  }
}

export async function syncChallengeDeleteToCloud(chId: string) {
  const user = auth.currentUser;
  if (!user || !isFirebaseAdminUser(user)) return;
  const id = sanitizeId(chId, 'ch');
  try {
    await deleteDoc(doc(db, 'challenges', id));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `challenges/${id}`);
  }
}

export async function syncBookingCreateToCloud(booking: any, userOverride?: User | null): Promise<boolean> {
  const user = userOverride || (await getCurrentAuthUser());
  if (!user || !user.emailVerified) return false;
  const bookingId = sanitizeId(booking.id, 'book');
  const mentorId = sanitizeId(booking.mentorId, 'mentor');

  try {
    const mentorSnap = await getDoc(doc(db, 'mentors_public', mentorId));
    if (!mentorSnap.exists()) return false;

    await setDoc(doc(db, 'bookings', bookingId), {
      id: bookingId,
      ownerUid: sanitizeId(user.uid, 'uid'),
      mentorId,
      mentorOwnerUid: sanitizeId(mentorSnap.data()?.ownerUid || '', 'uid'),
      mentorName: clampStr(booking.mentorName, 120),
      studentName: clampStr(booking.studentName, 120),
      day: clampStr(booking.day, 40),
      time: clampStr(booking.time, 40),
      question: clampStr(booking.question, 1000),
      amount: clampNum(booking.amount, 0, 100000, 200),
      meetLink: clampStr(booking.meetLink, 300),
      status: clampStr(booking.status, 40, 'مدفوعة ومؤكدة'),
      hasBeenRated: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `bookings/${bookingId}`);
  }
}

export async function syncBookingRatingToCloud(
  bookingId: string | undefined,
  mentorId: string,
  rating: number,
  comment: string,
  newAvgRating: string,
  reviewsList: any[],
  sessionsCount: number,
  userOverride?: User | null
): Promise<boolean> {
  const user = userOverride || (await getCurrentAuthUser());
  if (!user || !user.emailVerified) return false;
  const mid = sanitizeId(mentorId, 'mentor');

  try {
    const pubRef = doc(db, 'mentors_public', mid);
    const pubSnap = await getDoc(pubRef);
    const batch = writeBatch(db);
    let hasWrites = false;

    if (pubSnap.exists()) {
      const sanitizedReviews = (Array.isArray(reviewsList) ? reviewsList : []).slice(0, 100).map((r) => ({
        id: clampStr(r.id, 80, `rev-${Date.now()}`),
        mentorId: mid,
        studentName: clampStr(r.studentName, 120, 'طالب إعلام'),
        rating: clampNum(r.rating, 1, 5, 5),
        comment: clampStr(r.comment, 600),
        date: clampStr(r.date, 64)
      }));
      batch.update(pubRef, {
        rating: clampStr(newAvgRating, 10, '5.0'),
        reviewsList: sanitizedReviews,
        sessionsCount: clampNum(sessionsCount, 0, 100000, 1),
        updatedAt: serverTimestamp()
      });
      hasWrites = true;
    }

    if (bookingId) {
      const bid = sanitizeId(bookingId, 'book');
      const bRef = doc(db, 'bookings', bid);
      const bSnap = await getDoc(bRef);
      if (bSnap.exists() && bSnap.data()?.ownerUid === user.uid) {
        batch.update(bRef, {
          hasBeenRated: true,
          rating: clampNum(rating, 1, 5, 5),
          comment: clampStr(comment, 600),
          updatedAt: serverTimestamp()
        });
        hasWrites = true;
      }
    }

    if (hasWrites) {
      await batch.commit();
    }
    return hasWrites;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `mentors_public/${mid}`);
  }
}

export async function syncSubmissionCreateToCloud(
  sub: any,
  challengeSubmissionsCount?: number,
  userOverride?: User | null
): Promise<boolean> {
  const user = userOverride || (await getCurrentAuthUser());
  if (!user || !user.emailVerified) return false;
  const subId = sanitizeId(sub.id, 'sub');
  const chId = sanitizeId(sub.challengeId, 'ch');
  try {
    await setDoc(doc(db, 'submissions', subId), {
      id: subId,
      ownerUid: sanitizeId(user.uid, 'uid'),
      challengeId: chId,
      studentName: clampStr(sub.studentName, 120, 'طالب إعلام'),
      category: clampStr(sub.category, 80),
      title: clampStr(sub.title, 200),
      content: clampStr(sub.content, 8000),
      link: clampStr(sub.link, 500),
      score: clampNum(sub.score, 0, 100, 60),
      requirements_met: Boolean(sub.requirements_met),
      mistakes: Array.isArray(sub.mistakes) ? sub.mistakes.slice(0, 10).map((m: unknown) => clampStr(m, 400)) : [],
      feedback: clampStr(sub.feedback, 2000),
      skillArabic: clampStr(sub.skillArabic, 60),
      skillDelta: clampNum(sub.skillDelta, -20, 20, 0),
      newOvr: clampNum(sub.newOvr, 0, 100, 0),
      date: clampStr(sub.date, 64),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    if (typeof challengeSubmissionsCount === 'number') {
      const chRef = doc(db, 'challenges', chId);
      if ((await getDoc(chRef)).exists()) {
        await updateDoc(chRef, {
          submissionsCount: clampNum(challengeSubmissionsCount, 0, 100000, 1),
          updatedAt: serverTimestamp()
        });
      }
    }
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `submissions/${subId}`);
  }
}

export async function syncReportCreateToCloud(report: any, userOverride?: User | null): Promise<boolean> {
  const user = userOverride || (await getCurrentAuthUser());
  if (!user || !user.emailVerified) return false;
  const repId = sanitizeId(report.id, 'rep');
  try {
    await setDoc(doc(db, 'reports', repId), {
      id: repId,
      reporterUid: sanitizeId(user.uid, 'uid'),
      reportedId: sanitizeId(report.reportedId, 'target'),
      reportedName: clampStr(report.reportedName, 160),
      reportedType: ['mentor', 'company', 'student'].includes(report.reportedType) ? report.reportedType : 'mentor',
      reason: clampStr(report.reason, 120, 'حساب وهمي'),
      description: clampStr(report.description, 1500),
      screenshot: clampMediaRef(report.screenshot, 150000),
      date: clampStr(report.date, 64),
      status: 'pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `reports/${repId}`);
  }
}

export async function syncReportActionToCloud(reportId: string, status: string) {
  const user = auth.currentUser;
  if (!user || !isFirebaseAdminUser(user)) return;
  const repId = sanitizeId(reportId, 'rep');
  try {
    const ref = doc(db, 'reports', repId);
    if ((await getDoc(ref)).exists()) {
      await updateDoc(ref, {
        status: ['pending', 'approved_banned', 'warned', 'rejected'].includes(status) ? status : 'pending',
        updatedAt: serverTimestamp()
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `reports/${repId}`);
  }
}

export async function syncBlacklistIpAddToCloud(item: any): Promise<boolean> {
  const user = await getCurrentAuthUser();
  if (!user || !isFirebaseAdminUser(user)) return false;
  const ipId = sanitizeId(item.id || item.ip, 'ip');
  try {
    await setDoc(doc(db, 'blacklist_ips', ipId), {
      id: ipId,
      ip: clampStr(item.ip, 64),
      reason: clampStr(item.reason, 300),
      date: clampStr(item.date, 64),
      addedBy: clampStr(item.addedBy, 120, 'إدارة المنصة'),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `blacklist_ips/${ipId}`);
  }
}

export async function syncBlacklistIpDeleteToCloud(ipIdOrIp: string) {
  const user = auth.currentUser;
  if (!user || !isFirebaseAdminUser(user)) return;
  const ipId = sanitizeId(ipIdOrIp, 'ip');
  try {
    await deleteDoc(doc(db, 'blacklist_ips', ipId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `blacklist_ips/${ipId}`);
  }
}

export async function syncPortfolioItemCreateToCloud(item: any, userOverride?: User | null): Promise<boolean> {
  const user = userOverride || (await getCurrentAuthUser());
  if (!user || !user.emailVerified) return false;
  const itemId = sanitizeId(item.id, 'port');
  const rawUrl = item.url || item.link || item.fileUrl || '';
  const safeUrl = rawUrl.startsWith('blob:') ? `idb://${itemId}` : clampMediaRef(rawUrl, 150000, `idb://${itemId}`);
  try {
    const ref = doc(db, 'portfolio_items', itemId);
    const existingSnap = await getDoc(ref);
    if (existingSnap.exists()) {
      return true;
    }
    await setDoc(ref, {
      id: itemId,
      ownerUid: sanitizeId(user.uid, 'uid'),
      studentName: clampStr(item.studentName, 120),
      title: clampStr(item.title, 200, 'عمل إعلامي'),
      type: clampStr(item.type, 60, 'فيديو'),
      date: clampStr(item.date, 64),
      url: safeUrl,
      description: clampStr(item.desc || item.description, 1000),
      tools: clampStr(item.tools, 200),
      mode: item.mode === 'file' ? 'file' : 'link',
      fileName: clampStr(item.fileName, 200),
      fileSizeStr: clampStr(item.fileSizeStr, 40),
      approvalStatus: 'pending',
      views: clampNum(item.views, 0, 10000000, 1),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `portfolio_items/${itemId}`);
  }
}

export async function syncPortfolioItemDecisionToCloud(itemId: string, approvalStatus: 'approved' | 'rejected') {
  const user = auth.currentUser;
  if (!user || !isFirebaseAdminUser(user)) return;
  const id = sanitizeId(itemId, 'port');
  try {
    const ref = doc(db, 'portfolio_items', id);
    if ((await getDoc(ref)).exists()) {
      await updateDoc(ref, { approvalStatus, updatedAt: serverTimestamp() });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `portfolio_items/${id}`);
  }
}

export async function syncPortfolioItemDeleteFromCloud(itemId: string) {
  const user = await getCurrentAuthUser();
  if (!user || !user.emailVerified) return;
  const id = sanitizeId(itemId, 'port');
  try {
    const ref = doc(db, 'portfolio_items', id);
    if ((await getDoc(ref)).exists()) {
      await deleteDoc(ref);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `portfolio_items/${id}`);
  }
}
