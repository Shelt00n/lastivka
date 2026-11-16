import { useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "lastivka.theme";

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export function applyTheme(pref: ThemePref = readPref()) {
  const dark = pref === "dark" || (pref === "system" && media().matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#17212b" : "#f7f7f8");
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readPref);

  useEffect(() => {
    applyTheme(pref);
    if (pref !== "system") return;
    const m = media();
    const onChange = () => applyTheme("system");
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, [pref]);

  const update = (next: ThemePref) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode: theme just won't persist */
    }
    setPref(next);
  };

  return [pref, update] as const;
}
