import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { House, ListTodo, Library, Settings, UserRound } from "lucide-react";
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
} from "react-router";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { AuthScreen } from "./auth/AuthScreen";
import { RecoveryScreen } from "./auth/RecoveryScreen";
import { I18nProvider, friendlyError, useI18n } from "./i18n";
import { JobsPage, JobDetailPage } from "./jobs/JobsUI";
import { PlayerProvider } from "./player/PlayerProvider";
import { MiniPlayer, PlayerPage } from "./player/PlayerUI";
import { HomePage } from "./home/HomePage";
import { LibraryPage } from "./library/LibraryPage";
import { SettingsPage } from "./settings/SettingsPage";
import { AccountPage } from "./settings/AccountPage";
import { accentFor, applyAccent } from "./settings/accent";
import { useSignedIn } from "./auth/AuthProvider";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) =>
        count < 2 &&
        !(
          "status" in error &&
          [400, 401, 403, 404, 409, 429].includes(Number(error.status))
        ),
      staleTime: 10_000,
    },
  },
});

function Navigation() {
  const { t } = useI18n();
  const items = [
    { path: "/", label: "home", Icon: House },
    { path: "/jobs", label: "jobs", Icon: ListTodo },
    { path: "/library", label: "library", Icon: Library },
    { path: "/settings", label: "settings", Icon: Settings },
  ] as const;
  return (
    <nav className="navigation" aria-label={t("manage")}>
      {items.map(({ path, label, Icon }) => (
        <NavLink
          key={path}
          to={path}
          end={path === "/"}
          className={({ isActive }) =>
            isActive ? "nav-item active" : "nav-item"
          }
        >
          <Icon size={22} aria-hidden="true" />
          <span>{t(label)}</span>
        </NavLink>
      ))}
    </nav>
  );
}

export function Shell() {
  const { t } = useI18n();
  const { user } = useSignedIn();
  useEffect(() => {
    applyAccent(accentFor(user.uid));
  }, [user.uid]);
  return (
    <PlayerProvider>
      <div className="app-shell">
        <aside className="sidebar">
          <Link to="/" className="brand">
            <span className="brand-mark">M</span>
            <span>{t("brand")}</span>
          </Link>
          <Navigation />
          <div className="sidebar-bottom">
            <Link to="/account">{t("account")}</Link>
          </div>
        </aside>
        <div className="main-area">
          <header className="mobile-header">
            <Link className="brand" to="/">
              <span className="brand-mark">M</span>
              <span>{t("brand")}</span>
            </Link>
            <Link to="/account" aria-label={t("account")}>
              <UserRound size={24} aria-hidden="true" />
            </Link>
          </header>
          <main className="content">
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/jobs" element={<JobsPage />} />
              <Route path="/jobs/:id" element={<JobDetailPage />} />
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/player" element={<PlayerPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/account" element={<AccountPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
          <MiniPlayer />
          <div className="mobile-nav">
            <Navigation />
          </div>
        </div>
      </div>
    </PlayerProvider>
  );
}

function Gate() {
  const { state, retry } = useAuth();
  const { t } = useI18n();
  if (state.phase === "restoring")
    return (
      <main className="center-state" role="status">
        {t("loading")}
      </main>
    );
  if (state.phase === "error")
    return (
      <main className="center-state">
        <p role="alert">{friendlyError(new Error(state.message), t)}</p>
        <button type="button" onClick={retry}>
          {t("retry")}
        </button>
      </main>
    );
  if (state.phase === "signedOut") return <AuthScreen />;
  if (state.phase === "recovery") return <RecoveryScreen />;
  return <Shell key={state.user.uid} />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <BrowserRouter>
          <AuthProvider>
            <Gate />
          </AuthProvider>
        </BrowserRouter>
      </I18nProvider>
    </QueryClientProvider>
  );
}
