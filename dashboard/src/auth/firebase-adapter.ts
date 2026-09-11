import { getApp, getApps, initializeApp } from "firebase/app";
import {
  browserSessionPersistence,
  getAuth,
  GoogleAuthProvider,
  onIdTokenChanged,
  reauthenticateWithPopup,
  setPersistence,
  signInWithPopup,
  signOut,
} from "firebase/auth";

import { publicConfig } from "@/config";
import type { AuthAdapter, AuthUser } from "./admin-session";

export const createAuthAdapter = (): AuthAdapter => {
  if (!publicConfig.firebase) {
    return {
      observe(listener) {
        listener(null);
        return () => undefined;
      },
      async signIn() {
        throw new Error("Firebase web configuration is missing.");
      },
      async signOut() {},
      async reauthenticate() {
        throw new Error("Firebase web configuration is missing.");
      },
    };
  }
  const app = getApps().length
    ? getApp()
    : initializeApp(publicConfig.firebase);
  const auth = getAuth(app);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  const persistenceReady = setPersistence(auth, browserSessionPersistence);

  const mapUser = (user: typeof auth.currentUser): AuthUser | null =>
    user
      ? {
          uid: user.uid,
          email: user.email,
          getIdToken: (forceRefresh) => user.getIdToken(forceRefresh),
        }
      : null;

  return {
    observe(listener) {
      return onIdTokenChanged(auth, (user) => listener(mapUser(user)));
    },
    async signIn() {
      await persistenceReady;
      await signInWithPopup(auth, provider);
    },
    async signOut() {
      await persistenceReady;
      await signOut(auth);
    },
    async reauthenticate() {
      await persistenceReady;
      if (!auth.currentUser) throw new Error("Sign in again to continue.");
      await reauthenticateWithPopup(auth.currentUser, provider);
    },
  };
};
