import { useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
export type ThemeName = "light" | "dark";
const KEY = "devicedock.theme";

export function getPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}
export function effectiveTheme(pref: ThemePref = getPref()): ThemeName {
  if (pref !== "system") return pref;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
export function applyTheme(pref: ThemePref = getPref()) {
  document.documentElement.setAttribute("data-theme", effectiveTheme(pref));
}
export function setPref(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {}
  applyTheme(pref);
}

/** Current theme preference, plus the theme actually in effect (follows the OS while on "system"). */
export function useTheme() {
  const [pref, setPrefState] = useState<ThemePref>(getPref);
  const [theme, setTheme] = useState<ThemeName>(() => effectiveTheme());
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: light)");
    const onOs = () => {
      if (getPref() === "system") applyTheme("system");
    };
    mq.addEventListener("change", onOs);
    // data-theme is the single source of truth; mirror it into React state.
    const obs = new MutationObserver(() =>
      setTheme(
        document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark",
      ),
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    applyTheme();
    return () => {
      mq.removeEventListener("change", onOs);
      obs.disconnect();
    };
  }, []);
  return {
    pref,
    theme,
    choose(next: ThemePref) {
      setPrefState(next);
      setPref(next);
    },
  };
}

/** Theme name only, for components that must restyle imperative widgets (xterm). */
export function useThemeName(): ThemeName {
  return useTheme().theme;
}
