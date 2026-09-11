import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

type Theme = "light" | "dark";
const ThemeContext = createContext<{ theme: Theme; toggle(): void } | null>(
  null,
);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("musicmute:theme");
    if (stored === "light" || stored === "dark") return stored;
    return matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem("musicmute:theme", theme);
  }, [theme]);
  return (
    <ThemeContext.Provider
      value={{
        theme,
        toggle: () =>
          setTheme((current) => (current === "dark" ? "light" : "dark")),
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme requires ThemeProvider.");
  return value;
};
