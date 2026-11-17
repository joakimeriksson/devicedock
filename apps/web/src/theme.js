import { useEffect, useState } from "./html.js";

/** @typedef {"system" | "light" | "dark"} ThemePref */
/** @typedef {"light" | "dark"} ThemeName */
const KEY = "devicedock.theme";

/** @returns {ThemePref} */
export function getPref() {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}
/** @returns {ThemeName} */
export function effectiveTheme(pref = getPref()) {
  if (pref !== "system") return pref;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
export function applyTheme(pref = getPref()) {
  document.documentElement.setAttribute("data-theme", effectiveTheme(pref));
}
/** @param {ThemePref} pref */
export function setPref(pref) {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {}
  applyTheme(pref);
}

/** Current theme preference, plus the theme actually in effect (follows the OS while on "system"). */
export function useTheme() {
  const [pref, setPrefState] = useState(getPref);
  const [theme, setTheme] = useState(() => effectiveTheme());
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: light)");
    const onOs = () => {
      if (getPref() === "system") applyTheme("system");
    };
    mq.addEventListener("change", onOs);
    // data-theme is the single source of truth; mirror it into component state.
    const obs = new MutationObserver(() =>
      setTheme(document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"),
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
    /** @param {ThemePref} next */
    choose(next) {
      setPrefState(next);
      setPref(next);
    },
  };
}

/** Theme name only, for components that must restyle imperative widgets (xterm). */
export function useThemeName() {
  return useTheme().theme;
}
