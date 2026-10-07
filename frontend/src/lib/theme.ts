import { useState } from 'react';

/**
 * Light / dark theme. The palette itself lives in index.css under
 * [data-theme="light"]; this only flips the attribute and remembers the choice.
 * index.html applies the stored value before first paint, so there is no flash.
 */
export type Theme = 'dark' | 'light';

const KEY = 'ep_theme';

const readTheme = (): Theme => {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
};

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Private mode: the switch still works for this page view.
    }
    setTheme(next);
  };
  return [theme, toggle];
}
