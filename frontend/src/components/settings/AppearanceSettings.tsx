import React from 'react';
import { Check, Monitor, Moon, RotateCcw, Sparkles, Sun } from 'lucide-react';
import {
  ACCENTS,
  DEFAULT_APPEARANCE,
  resolveTheme,
  useAppearance,
  type Appearance,
  type ButtonShape,
  type ButtonStyle,
  type ThemeMode,
} from '../../lib/theme';
import { Button, buttonClass } from '../common/Button';

/**
 * Settings → Appearance: theme mode, brand colour, button shape and button
 * style.
 *
 * Every choice applies the moment it is clicked, to the whole app, and is
 * remembered in this browser (lib/theme.ts). No colour is written here: the
 * swatches and mock-ups read the palette tokens from theme.css.

 */

const BRAND_GRADIENT = 'linear-gradient(135deg, var(--brand-400), var(--brand-700))';

const same = (a: Appearance, b: Appearance) =>
  a.mode === b.mode && a.accent === b.accent && a.shape === b.shape && a.buttonStyle === b.buttonStyle;

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const Section: React.FC<{ title: string; hint: string; children: React.ReactNode; aside?: React.ReactNode }> = ({
  title,
  hint,
  children,
  aside,
}) => (
  <section className="bg-surface/90 border border-line rounded-2xl p-5 sm:p-6 shadow-lg">
    <div className="flex items-start justify-between gap-3 mb-4">
      <div>
        <h4 className="text-sm font-bold text-fg">{title}</h4>
        <p className="text-xs text-fg-muted mt-0.5">{hint}</p>
      </div>
      {aside}
    </div>
    {children}
  </section>
);

const Tick: React.FC<{ on: boolean }> = ({ on }) => (
  <span
    aria-hidden
    className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 transition-colors ${
      on ? 'border-transparent text-on-accent' : 'border-line-strong'
    }`}
    style={on ? { background: 'var(--brand-600)' } : undefined}
  >
    {on && <Check className="w-2.5 h-2.5" strokeWidth={3} />}
  </span>
);

/** A selectable card. The group around it is a radiogroup. */
const OptionCard: React.FC<{
  selected: boolean;
  onSelect: () => void;
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}> = ({ selected, onSelect, label, hint, icon, children }) => (
  <button
    type="button"
    role="radio"
    aria-checked={selected}
    onClick={onSelect}
    className={`text-left rounded-xl border p-2.5 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 ${
      selected
        ? 'border-brand-500/70 bg-brand-500/[0.06] ring-1 ring-brand-500/40'
        : 'border-line bg-page/40 hover:border-line-strong'
    }`}
  >
    {children}
    <span className="flex items-center gap-2 mt-2.5 px-0.5">
      {icon && <span className={selected ? 'text-brand-400' : 'text-fg-subtle'}>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className={`block text-xs font-bold ${selected ? 'text-fg' : 'text-fg-muted'}`}>{label}</span>
        {hint && <span className="block text-2xs text-fg-subtle truncate">{hint}</span>}
      </span>
      <Tick on={selected} />
    </span>
  </button>
);

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/** Raw palette tokens, so each mock-up shows its own theme whatever is on screen. */
const MOCK = {
  dark: {
    page: 'var(--neutral-dark-950)',
    card: 'var(--neutral-dark-900)',
    line: 'var(--neutral-dark-800)',
    text: 'var(--neutral-dark-700)',
    strong: 'var(--neutral-200)',
  },
  light: {
    page: 'var(--neutral-light-page)',
    card: 'var(--neutral-light-card)',
    line: 'var(--neutral-200)',
    text: 'var(--neutral-300)',
    strong: 'var(--neutral-700)',
  },
} as const;

/** A tiny app: sidebar, heading, a card with a brand button. */
const AppMock: React.FC<{ theme: 'dark' | 'light' }> = ({ theme }) => {
  const c = MOCK[theme];
  return (
    <div className="h-full w-full flex" style={{ background: c.page }}>
      <div className="w-[30%] p-1.5 space-y-1 border-r" style={{ background: c.card, borderColor: c.line }}>
        <div className="h-1.5 w-3/4 rounded-full" style={{ background: 'var(--brand-500)' }} />
        <div className="h-1 w-full rounded-full" style={{ background: c.line }} />
        <div className="h-1 w-5/6 rounded-full" style={{ background: c.line }} />
        <div className="h-1 w-2/3 rounded-full" style={{ background: c.line }} />
      </div>
      <div className="flex-1 p-2 space-y-1.5">
        <div className="h-1.5 w-1/2 rounded-full" style={{ background: c.strong }} />
        <div className="rounded-md border p-1.5 space-y-1" style={{ background: c.card, borderColor: c.line }}>
          <div className="h-1 w-5/6 rounded-full" style={{ background: c.text }} />
          <div className="h-1 w-2/3 rounded-full" style={{ background: c.text }} />
          <div className="h-2.5 w-10 rounded-sm mt-1" style={{ background: 'var(--brand-600)' }} />
        </div>
      </div>
    </div>
  );
};

const MODES: { id: ThemeMode; label: string; hint: string; icon: React.ReactNode }[] = [
  { id: 'dark', label: 'Dark', hint: 'Easy on the eyes', icon: <Moon className="w-3.5 h-3.5" /> },
  { id: 'light', label: 'Light', hint: 'Bright and crisp', icon: <Sun className="w-3.5 h-3.5" /> },
  { id: 'system', label: 'System', hint: 'Follows your device', icon: <Monitor className="w-3.5 h-3.5" /> },
];

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

const SHAPES: { id: ButtonShape; label: string; hint: string }[] = [
  { id: 'rounded', label: 'Rounded', hint: 'Soft corners' },
  { id: 'pill', label: 'Pill', hint: 'Fully round' },
  { id: 'sharp', label: 'Sharp', hint: 'Crisp corners' },
];

const STYLES: { id: ButtonStyle; label: string; hint: string }[] = [
  { id: 'solid', label: 'Solid', hint: 'Flat and clean' },
  { id: 'gradient', label: 'Gradient', hint: 'Subtle depth' },
  { id: 'glow', label: 'Glow', hint: 'Soft coloured halo' },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export const AppearanceSettings: React.FC = () => {
  const [appearance, set] = useAppearance();
  const isDefault = same(appearance, DEFAULT_APPEARANCE);
  const accentLabel = ACCENTS.find((a) => a.id === appearance.accent)?.label ?? '';
  const isDark = resolveTheme(appearance.mode) === 'dark';

  return (
    <div className="space-y-5">
      {/* Live preview: the real components, so what you see is what the app gets. */}
      <section className="relative overflow-hidden rounded-2xl border border-line bg-surface/90 shadow-xl">
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(60% 120% at 100% 0%, color-mix(in srgb, var(--brand-500) 16%, transparent), transparent 70%)',
          }}
        />
        <div className="relative p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span
                className="w-10 h-10 rounded-xl text-on-accent flex items-center justify-center shadow-lg"
                style={{ background: BRAND_GRADIENT }}
              >
                <Sparkles className="w-5 h-5" />
              </span>
              <div>
                <h4 className="text-base font-bold text-fg">Appearance</h4>
                <p className="text-xs text-fg-muted">
                  {isDark ? 'Dark' : 'Light'} · {accentLabel}
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => set(DEFAULT_APPEARANCE)}
              disabled={isDefault}
              icon={<RotateCcw />}
            >
              Reset
            </Button>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button icon={<Sparkles />}>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="link">Text link</Button>
            <span className="ml-1 px-2 py-1 rounded-full text-2xs font-semibold bg-brand-500/15 text-brand-300 border border-brand-500/30">
              Active
            </span>
          </div>
        </div>
      </section>

      <Section title="Mode" hint="How the whole app looks. System switches with your device’s setting.">
        <div role="radiogroup" aria-label="Mode" className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {MODES.map((m) => (
            <OptionCard
              key={m.id}
              selected={appearance.mode === m.id}
              onSelect={() => set({ mode: m.id })}
              label={m.label}
              hint={m.hint}
              icon={m.icon}
            >
              <div className="h-24 rounded-lg overflow-hidden border border-line">
                {m.id === 'system' ? (
                  <div className="h-full flex">
                    <div className="w-1/2 overflow-hidden">
                      <div className="w-[200%] h-full">
                        <AppMock theme="dark" />
                      </div>
                    </div>
                    <div className="w-1/2 overflow-hidden">
                      <div className="w-[200%] h-full -translate-x-1/2">
                        <AppMock theme="light" />
                      </div>
                    </div>
                  </div>
                ) : (
                  <AppMock theme={m.id} />
                )}
              </div>
            </OptionCard>
          ))}
        </div>
      </Section>

      <Section
        title="Brand colour"
        hint="Buttons, links, the active menu item, focus rings and charts."
        aside={<span className="text-2xs font-semibold text-brand-300 shrink-0">{accentLabel}</span>}
      >
        <div role="radiogroup" aria-label="Brand colour" className="flex flex-wrap gap-3">
          {ACCENTS.map((a) => {
            const selected = appearance.accent === a.id;
            return (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={a.label}
                title={a.label}
                onClick={() => set({ accent: a.id })}
                // Scopes the brand scale to this swatch, so it shows its own preset.
                data-accent={a.id}
                className="flex flex-col items-center gap-1.5 w-14 cursor-pointer focus:outline-none group"
              >
                <span
                  className="w-10 h-10 rounded-full flex items-center justify-center transition-transform group-hover:scale-105 group-focus-visible:ring-2 group-focus-visible:ring-brand-500/50"
                  style={{
                    background: BRAND_GRADIENT,
                    boxShadow: selected ? '0 0 0 2px var(--color-surface), 0 0 0 4px var(--brand-500)' : undefined,
                  }}
                >
                  {selected && <Check className="w-4 h-4 text-on-accent" strokeWidth={3} />}
                </span>
                <span className={`text-2xs font-semibold ${selected ? 'text-fg' : 'text-fg-subtle'}`}>{a.label}</span>
              </button>
            );
          })}
        </div>
      </Section>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <Section title="Button shape" hint="The corners of every button.">
          <div role="radiogroup" aria-label="Button shape" className="grid grid-cols-3 gap-2.5">
            {SHAPES.map((s) => (
              <OptionCard
                key={s.id}
                selected={appearance.shape === s.id}
                onSelect={() => set({ shape: s.id })}
                label={s.label}
                hint={s.hint}
              >
                <div
                  data-shape={s.id}
                  className="h-16 rounded-lg bg-page/60 border border-line flex items-center justify-center"
                >
                  <span aria-hidden className={buttonClass({ size: 'sm', className: 'pointer-events-none' })}>
                    Button
                  </span>
                </div>
              </OptionCard>
            ))}
          </div>
        </Section>

        <Section title="Button style" hint="How the main buttons are filled.">
          <div role="radiogroup" aria-label="Button style" className="grid grid-cols-3 gap-2.5">
            {STYLES.map((s) => (
              <OptionCard
                key={s.id}
                selected={appearance.buttonStyle === s.id}
                onSelect={() => set({ buttonStyle: s.id })}
                label={s.label}
                hint={s.hint}
              >
                <div
                  data-button-style={s.id}
                  className="h-16 rounded-lg bg-page/60 border border-line flex items-center justify-center"
                >
                  <span aria-hidden className={buttonClass({ size: 'sm', className: 'pointer-events-none' })}>
                    Button
                  </span>
                </div>
              </OptionCard>
            ))}
          </div>
        </Section>
      </div>

      <p className="text-2xs text-fg-subtle px-1">
        Appearance is saved in this browser and applies to everyone who signs in on it.
      </p>
    </div>
  );
};
