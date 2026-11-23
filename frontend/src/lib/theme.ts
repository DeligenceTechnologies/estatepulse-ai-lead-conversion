import { useSyncExternalStore } from 'react';

/**
 * Appearance: theme mode, brand colour, button shape and button style.
 *
 * The colours themselves live in theme.css; this only sets attributes on
 * <html> that theme.css reacts to (data-theme, data-accent, data-shape,
 * data-button-style) and remembers the choice in this browser. index.html
 * applies the stored value before first paint, so a reload never flashes the
 * default look.
 *
 * One module-level store, so the navbar toggle and Settings → Appearance
 * always agree without a context provider.
 */
export type ThemeMode = 'dark' | 'light' | 'system';
export type Theme = 'dark' | 'light';
export type Accent =
  | 'emerald'
  | 'teal'
  | 'cyan'
  | 'sky'
  | 'blue'
  | 'indigo'
  | 'violet'
  | 'purple'
  | 'fuchsia'
  | 'pink'
  | 'rose'
  | 'red'
  | 'orange'
  | 'gold';
export type AccentGroup = 'cool' | 'vibrant' | 'warm';
export type ButtonShape = 'rounded' | 'pill' | 'sharp';
export type ButtonStyle = 'solid' | 'gradient' | 'glow';

export interface Appearance {
  mode: ThemeMode;
  accent: Accent;
  shape: ButtonShape;
  buttonStyle: ButtonStyle;
}

/** In display order. Each has a matching [data-accent] block in theme.css (emerald is the default scale). */
export const ACCENTS: { id: Accent; label: string; group: AccentGroup }[] = [
  { id: 'emerald', label: 'Emerald', group: 'cool' },
  { id: 'teal', label: 'Teal', group: 'cool' },
  { id: 'cyan', label: 'Cyan', group: 'cool' },
  { id: 'sky', label: 'Sky', group: 'cool' },
  { id: 'blue', label: 'Blue', group: 'cool' },
  { id: 'indigo', label: 'Indigo', group: 'cool' },
  { id: 'violet', label: 'Violet', group: 'vibrant' },
  { id: 'purple', label: 'Purple', group: 'vibrant' },
  { id: 'fuchsia', label: 'Fuchsia', group: 'vibrant' },
  { id: 'pink', label: 'Pink', group: 'vibrant' },
  { id: 'rose', label: 'Rose', group: 'warm' },
  { id: 'red', label: 'Crimson', group: 'warm' },
  { id: 'orange', label: 'Sunset', group: 'warm' },
  { id: 'gold', label: 'Gold', group: 'warm' },
];

export const DEFAULT_APPEARANCE: Appearance = { mode: 'dark', accent: 'emerald', shape: 'rounded', buttonStyle: 'solid' };

const KEY = 'ep_appearance';
/** The old key, from when only light/dark could be chosen. */
const LEGACY_KEY = 'ep_theme';

const MODES: ThemeMode[] = ['dark', 'light', 'system'];
const SHAPES: ButtonShape[] = ['rounded', 'pill', 'sharp'];
const STYLES: ButtonStyle[] = ['solid', 'gradient', 'glow'];

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

function read(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Appearance>;
      return {
        mode: pick(v.mode, MODES, DEFAULT_APPEARANCE.mode),
        accent: pick(
          v.accent,
          ACCENTS.map((a) => a.id),
          DEFAULT_APPEARANCE.accent,
        ),
        shape: pick(v.shape, SHAPES, DEFAULT_APPEARANCE.shape),
        buttonStyle: pick(v.buttonStyle, STYLES, DEFAULT_APPEARANCE.buttonStyle),
      };
    }
    if (localStorage.getItem(LEGACY_KEY) === 'light') return { ...DEFAULT_APPEARANCE, mode: 'light' };
  } catch {
    // Private mode or a corrupt value: fall back to the default look.
  }
  return DEFAULT_APPEARANCE;
}

const systemQuery = (): MediaQueryList | null =>
  typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

export const resolveTheme = (mode: ThemeMode): Theme =>
  mode === 'system' ? (systemQuery()?.matches ? 'light' : 'dark') : mode;

function apply(a: Appearance): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(a.mode);
  // The defaults are the bare stylesheet, so they carry no attribute.
  if (a.accent === 'emerald') delete root.dataset.accent;
  else root.dataset.accent = a.accent;
  if (a.shape === 'rounded') delete root.dataset.shape;
  else root.dataset.shape = a.shape;
  if (a.buttonStyle === 'solid') delete root.dataset.buttonStyle;
  else root.dataset.buttonStyle = a.buttonStyle;
}

let state: Appearance = read();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

// "System" follows the OS live, not only on load.
systemQuery()?.addEventListener('change', () => {
  if (state.mode !== 'system') return;
  apply(state);
  emit();
});

export function setAppearance(patch: Partial<Appearance>): void {
  state = { ...state, ...patch };
  apply(state);
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Not remembered, but still applied for this page view.
  }
  emit();
}

export const resetAppearance = (): void => setAppearance(DEFAULT_APPEARANCE);

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The saved appearance and a setter that applies it everywhere at once. */
export function useAppearance(): [Appearance, (patch: Partial<Appearance>) => void] {
  const value = useSyncExternalStore(subscribe, () => state);
  return [value, setAppearance];
}

/** The theme on screen right now, and a one-click flip (the navbar toggle). */
export function useTheme(): [Theme, () => void] {
  const [appearance] = useAppearance();
  const theme = resolveTheme(appearance.mode);
  return [theme, () => setAppearance({ mode: theme === 'dark' ? 'light' : 'dark' })];
}
