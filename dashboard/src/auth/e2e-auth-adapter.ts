import type { AdminRole } from "@/api/contracts";
import type { AuthAdapter, AuthUser } from "./admin-session";

const E2E_ROLE_KEY = "musicmute:e2e-role";

const e2eUser = (role: AdminRole): AuthUser => ({
  uid: `${role}-fixture`,
  email: `${role}-fixture@example.invalid`,
  getIdToken: async () => `${role}-fixture`,
});

export const createAuthAdapter = (): AuthAdapter => {
  let listener: (user: AuthUser | null) => void = () => undefined;
  return {
    observe(next) {
      listener = next;
      const role = sessionStorage.getItem(E2E_ROLE_KEY) as AdminRole | null;
      next(role ? e2eUser(role) : null);
      return () => {
        listener = () => undefined;
      };
    },
    async signIn() {
      const role =
        (sessionStorage.getItem(E2E_ROLE_KEY) as AdminRole | null) ?? "owner";
      sessionStorage.setItem(E2E_ROLE_KEY, role);
      listener(e2eUser(role));
    },
    async signOut() {
      sessionStorage.removeItem(E2E_ROLE_KEY);
      listener(null);
    },
    async reauthenticate() {
      const role = sessionStorage.getItem(E2E_ROLE_KEY) as AdminRole | null;
      if (!role) throw new Error("No signed-in test session.");
      listener(e2eUser(role));
    },
  };
};
