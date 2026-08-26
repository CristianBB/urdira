export type InterfaceTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "urdira.interface-theme";

export function resolveThemePreference(stored: string | null, systemPrefersDark: boolean): InterfaceTheme {
  if (stored === "light" || stored === "dark") return stored;
  return systemPrefersDark ? "dark" : "light";
}

export function toggledTheme(theme: InterfaceTheme): InterfaceTheme {
  return theme === "light" ? "dark" : "light";
}
