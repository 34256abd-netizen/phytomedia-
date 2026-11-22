import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDocFromServer,
  Firestore
} from 'firebase/firestore';
import appletConfig from '../firebase-applet-config.json';

export const firebaseConfig = {
  apiKey: "AIzaSyBwXpKKILTUEo1OrszjOSK2IID6PqNvHqQ",
  authDomain: "gen-lang-client-0113595152.firebaseapp.com",
  projectId: "gen-lang-client-0113595152",
  storageBucket: "gen-lang-client-0113595152.firebasestorage.app",
  messagingSenderId: "381067491371",
  appId: "1:381067491371:web:0900858c053bff6614126e",
  firestoreDatabaseId: appletConfig.firestoreDatabaseId
};

export const app: FirebaseApp = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const db: Firestore = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      displayName?: string | null;
      email?: string | null;
      photoUrl?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid ?? null,
      email: auth.currentUser?.email ?? null,
      emailVerified: auth.currentUser?.emailVerified ?? null,
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      tenantId: auth.currentUser?.tenantId ?? null,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          displayName: provider.displayName,
          email: provider.email,
          photoUrl: provider.photoURL,
        })) || [],
    },
    operationType,
    path,
  };
  const serialized = JSON.stringify(errInfo);
  console.error('Firestore Error: ', serialized);
  throw new Error(serialized);
}

let connectionTested = false;

export async function testConnection(): Promise<void> {
  if (connectionTested) return;
  connectionTested = true;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration. Firestore client is offline.');
    }
    // Permission-denied on test/connection is expected under default-deny rules and confirms online reachability.
  }
}

export function getFirebaseAuthErrorMessage(error: unknown): string {
  const code = (error && typeof error === 'object' && 'code' in error)
    ? String((error as { code?: unknown }).code || '')
    : '';
  const rawMessage = error instanceof Error ? error.message : String(error || '');

  switch (code) {
    case 'auth/popup-blocked':
      return 'تم حظر نافذة تسجيل دخول Google بواسطة المتصفح. من فضلك اسمح بالنوافذ المنبثقة (Pop-ups) لهذا الموقع ثم أعد المحاولة.';
    case 'auth/popup-closed-by-user':
      return 'تم إغلاق نافذة تسجيل الدخول قبل إتمام الخطوة. أعد الضغط على "دخول Google" لاختيار حسابك.';
    case 'auth/cancelled-popup-request':
      return 'يوجد طلب تسجيل دخول مفتوح بالفعل. انتظر لحظة أو أعد المحاولة.';
    case 'auth/unauthorized-domain': {
      const host = typeof window !== 'undefined' ? window.location.hostname : '';
      return `النطاق الحالي (${host || 'unknown'}) غير مضاف في Authorized Domains داخل Firebase Authentication. أضفه من لوحة Firebase ثم أعد المحاولة.`;
    }
    case 'auth/operation-not-allowed':
      return 'تسجيل الدخول بحساب Google غير مفعّل حالياً في إعدادات Firebase Authentication.';
    case 'auth/network-request-failed':
      return 'تعذر الاتصال بخوادم المصادقة بسبب ضعف أو انقطاع الإنترنت. تحقق من الشبكة وحاول مرة أخرى.';
    case 'auth/user-disabled':
      return 'تم تعطيل هذا الحساب. تواصل مع إدارة المنصة للمساعدة.';
    case 'auth/invalid-api-key':
      return 'مفتاح إعدادات Firebase غير صالح. يرجى مراجعة إعدادات المشروع.';
    case 'auth/internal-error':
      return 'حدث خطأ داخلي مؤقت في خدمة المصادقة. أعد تحميل الصفحة وحاول مجدداً.';
    default:
      if (rawMessage.includes('network')) {
        return 'مشكلة في الاتصال بالإنترنت أثناء تسجيل الدخول بحساب Google. حاول مرة أخرى.';
      }
      return `تعذر تسجيل الدخول عبر Google${code ? ` (${code})` : ''}. تأكد من السماح بالنوافذ المنبثقة وتفعيل Google Sign-In ثم حاول مجدداً.`;
  }
}

export async function signInWithGooglePopup(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  if (!result.user) {
    throw new Error('لم يتم إرجاع بيانات المستخدم من Google.');
  }
  return result.user;
}

export async function signOutFirebase(): Promise<void> {
  await signOut(auth);
}

export function subscribeAuthState(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, callback);
}
