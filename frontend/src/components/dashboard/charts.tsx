import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * The dashboard's charts, in plain SVG: no chart library, so they follow the
 * theme tokens (dark and light) like every other surface in the app.
 *
 * Marks stay thin (2px lines, small dots), grid and axes recede, and every
 * chart has a hover read-out, so a value is never colour alone.
 */

/** Width of an element, kept current as the layout changes. */
function useWidth<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  number,
] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) =>
      setWidth(Math.round(entry.contentRect.width)),
    );
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** A round top for the y-axis, and a tick step of 1, 2 or 5 × 10ⁿ giving at most four steps. */
function niceScale(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 4, step: 1 };
  const rough = max / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag;
  const unit = Math.max(1, step);
  return { top: Math.ceil(max / unit) * unit, step: unit };
}

const dayLabel = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

export interface TrendSeries {
  key: string;
  label: string;
  /** A CSS colour, normally a --viz-* token. */
  color: string;
  values: number[];
}

/**
 * Daily counts as lines, one per series, on one shared count axis.
 * Hover (or touch) anywhere puts a crosshair on the nearest day with every series' value.
 */
export const TrendChart: React.FC<{
  days: string[];
  series: TrendSeries[];
  height?: number;
}> = ({ days, series, height = 220 }) => {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const pad = { top: 12, right: 40, bottom: 26, left: 34 };
  const innerW = Math.max(0, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;
  const n = days.length;
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const { top, step } = niceScale(max);

  const x = (i: number) =>
    pad.left + (n <= 1 ? innerW / 2 : (i * innerW) / (n - 1));
  const y = (v: number) => pad.top + innerH - (v / top) * innerH;
  const ticks = Array.from(
    { length: Math.floor(top / step) + 1 },
    (_, i) => i * step,
  );
  // Fewer date labels on a narrow card; the last one (today) is always shown.
  const spacing = innerW / Math.max(1, n - 1);
  const every = spacing * 2 >= 60 ? 2 : spacing * 3 >= 60 ? 3 : 4;

  const pathOf = (values: number[]) =>
    values
      .map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .join("");

  const pick = (clientX: number, rect: DOMRect) => {
    if (n === 0 || innerW <= 0) return;
    const rel = clientX - rect.left - pad.left;
    setHover(
      Math.max(0, Math.min(n - 1, Math.round((rel / innerW) * (n - 1)))),
    );
  };

  const tipLeft = hover === null ? 0 : x(hover);
  const flip = hover !== null && tipLeft > width - 170;

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={series
            .map(
              (s) =>
                `${s.label}: ${s.values.reduce((a, b) => a + b, 0)} in ${n} days`,
            )
            .join("; ")}
          onMouseMove={(e) =>
            pick(e.clientX, e.currentTarget.getBoundingClientRect())
          }
          onMouseLeave={() => setHover(null)}
          onTouchStart={(e) =>
            pick(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())
          }
          onTouchMove={(e) =>
            pick(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())
          }
          className="block overflow-visible"
        >
          {/* Recessive horizontal grid and its count labels. */}
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={pad.left}
                x2={pad.left + innerW}
                y1={y(t)}
                y2={y(t)}
                className={t === 0 ? "stroke-slate-700" : "stroke-slate-800"}
                strokeWidth={1}
                strokeDasharray={t === 0 ? undefined : "3 4"}
              />
              <text
                x={pad.left - 8}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                className="fill-slate-500 text-2xs tabular-nums"
              >
                {t}
              </text>
            </g>
          ))}

          {days.map((d, i) =>
            i === n - 1 || (n - 1 - i) % every === 0 ? (
              <text
                key={d}
                x={x(i)}
                y={height - 6}
                textAnchor={i === n - 1 ? "end" : "middle"}
                className={`text-2xs ${hover === i ? "fill-slate-200" : "fill-slate-500"}`}
              >
                {i === n - 1 ? "Today" : dayLabel(d)}
              </text>
            ) : null,
          )}

          {/* Soft wash under the first series only: it is the one the page is about. */}
          <defs>
            <linearGradient id="trend-wash" x1="0" x2="0" y1="0" y2="1">
              <stop
                offset="0%"
                stopColor={series[0]?.color}
                stopOpacity={0.22}
              />
              <stop
                offset="100%"
                stopColor={series[0]?.color}
                stopOpacity={0}
              />
            </linearGradient>
          </defs>
          {series[0] && n > 1 && (
            <path
              d={`${pathOf(series[0].values)}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`}
              fill="url(#trend-wash)"
            />
          )}

          {series.map((s) => (
            <path
              key={s.key}
              d={pathOf(s.values)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {/* Today's value at the end of each line: the direct label. */}
          {hover === null &&
            series.map((s) => {
              const v = s.values[n - 1] ?? 0;
              return (
                <g key={s.key}>
                  <circle
                    cx={x(n - 1)}
                    cy={y(v)}
                    r={4}
                    fill={s.color}
                    className="stroke-slate-900"
                    strokeWidth={2}
                  />
                </g>
              );
            })}

          {hover !== null && (
            <g>
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={pad.top}
                y2={pad.top + innerH}
                className="stroke-slate-600"
                strokeWidth={1}
              />
              {series.map((s) => (
                <circle
                  key={s.key}
                  cx={x(hover)}
                  cy={y(s.values[hover] ?? 0)}
                  r={4.5}
                  fill={s.color}
                  className="stroke-slate-900"
                  strokeWidth={2}
                />
              ))}
            </g>
          )}
        </svg>
      )}

      {hover !== null && (
        <div
          className="absolute top-1 pointer-events-none z-10 min-w-36 bg-slate-950/95 border border-slate-700 rounded-xl px-3 py-2 shadow-xl"
          style={
            flip ? { right: width - tipLeft + 12 } : { left: tipLeft + 12 }
          }
        >
          <div className="text-2xs font-semibold text-slate-400 mb-1">
            {hover === n - 1
              ? "Today"
              : new Date(`${days[hover]}T12:00:00`).toLocaleDateString(
                  undefined,
                  { weekday: "short", month: "short", day: "numeric" },
                )}
          </div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-2 text-xs">
              <span
                className="w-2.5 h-0.5 rounded-full shrink-0"
                style={{ backgroundColor: s.color }}
              />
              <span className="text-slate-300 flex-1">{s.label}</span>
              <span className="font-bold text-white tabular-nums">
                {s.values[hover] ?? 0}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export interface DonutPart {
  key: string;
  label: string;
  value: number;
  /** A CSS colour. */
  fill: string;
}

/** One ring segment from angle a0 to a1 (radians, 0 = 12 o'clock, clockwise). */
function arc(
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  a0: number,
  a1: number,
): string {
  const p = (r: number, a: number) =>
    `${(cx + r * Math.sin(a)).toFixed(2)},${(cy - r * Math.cos(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(r1, a0)}A${r1},${r1} 0 ${large} 1 ${p(r1, a1)}L${p(r0, a1)}A${r0},${r0} 0 ${large} 0 ${p(r0, a0)}Z`;
}

/**
 * A whole in parts: a ring with the total (or the hovered part) in the middle,
 * and a legend that carries every name, share and count. Hovering a segment or
 * its legend row highlights that part and dims the rest.
 */
export const Donut: React.FC<{
  parts: DonutPart[];
  /** The big figure in the middle when nothing is hovered. */
  centerValue: React.ReactNode;
  centerLabel: string;
  size?: number;
}> = ({ parts, centerValue, centerLabel, size = 168 }) => {
  const [active, setActive] = useState<string | null>(null);
  const total = parts.reduce((n, p) => n + p.value, 0);
  const live = parts.filter((p) => p.value > 0);
  const c = size / 2;
  const r1 = c - 2;
  const r0 = r1 - 18;

  const segments = useMemo(() => {
    const gap = live.length > 1 ? 2.5 / ((r0 + r1) / 2) : 0;
    let a = 0;
    return live.map((p) => {
      const sweep = (p.value / total) * Math.PI * 2;
      const seg = { ...p, a0: a + gap / 2, a1: a + sweep - gap / 2 };
      a += sweep;
      return seg;
    });
  }, [live, total, r0, r1]);

  const shown = parts.find((p) => p.key === active);

  return (
    <div className="@container">
      <div className="flex flex-col @[30rem]:flex-row items-center gap-5">
        <div
          className="relative shrink-0"
          style={{ width: size, height: size }}
        >
          <svg
            width={size}
            height={size}
            role="img"
            aria-label={live.map((p) => `${p.label} ${p.value}`).join(", ")}
          >
            {total === 0 ? (
              <circle
                cx={c}
                cy={c}
                r={(r0 + r1) / 2}
                fill="none"
                className="stroke-slate-800"
                strokeWidth={r1 - r0}
              />
            ) : segments.length === 1 ? (
              <circle
                cx={c}
                cy={c}
                r={(r0 + r1) / 2}
                fill="none"
                stroke={segments[0].fill}
                strokeWidth={r1 - r0}
                onMouseEnter={() => setActive(segments[0].key)}
                onMouseLeave={() => setActive(null)}
              />
            ) : (
              segments.map((s) => (
                <path
                  key={s.key}
                  d={arc(
                    c,
                    c,
                    active === s.key ? r0 - 2 : r0,
                    active === s.key ? r1 + 1 : r1,
                    s.a0,
                    s.a1,
                  )}
                  fill={s.fill}
                  className="transition-opacity duration-150 cursor-pointer"
                  opacity={active && active !== s.key ? 0.3 : 1}
                  onMouseEnter={() => setActive(s.key)}
                  onMouseLeave={() => setActive(null)}
                />
              ))
            )}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none px-6">
            <span className="text-2xl font-bold text-white leading-none tabular-nums">
              {shown ? shown.value : centerValue}
            </span>
            <span className="text-2xs text-slate-400 mt-1 leading-tight">
              {shown
                ? `${shown.label} · ${total ? Math.round((shown.value / total) * 100) : 0}%`
                : centerLabel}
            </span>
          </div>
        </div>

        <ul className="flex-1 w-full min-w-0 space-y-1 list-none">
          {parts.map((p) => (
            <li
              key={p.key}
              onMouseEnter={() => setActive(p.value > 0 ? p.key : null)}
              onMouseLeave={() => setActive(null)}
              className={`flex items-center gap-2.5 text-xs rounded-lg px-2 py-1.5 transition-colors ${
                active === p.key ? "bg-slate-800/60" : ""
              }`}
            >
              <span
                className={`w-2.5 h-2.5 rounded-full shrink-0 ${p.value > 0 ? "" : "opacity-30"}`}
                style={{ backgroundColor: p.fill }}
                aria-hidden
              />
              <span
                className={`flex-1 min-w-0 truncate ${p.value > 0 ? "text-slate-300" : "text-slate-500"}`}
              >
                {p.label}
              </span>
              <span className="tabular-nums text-slate-500 w-9 text-right">
                {total > 0 ? `${Math.round((p.value / total) * 100)}%` : "—"}
              </span>
              <span
                className={`tabular-nums w-8 text-right ${p.value > 0 ? "font-bold text-white" : "text-slate-500"}`}
              >
                {p.value}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

/** A small trend line for a stat tile: shape only, no axes. */
export const Sparkline: React.FC<{
  values: number[];
  color: string;
  width?: number;
  height?: number;
}> = ({ values, color, width = 96, height = 32 }) => {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const pts = values.map(
    (v, i) =>
      [
        (i * (width - 4)) / (values.length - 1) + 2,
        height - 3 - (v / max) * (height - 6),
      ] as const,
  );
  const d = pts
    .map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`)
    .join("");
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg width={width} height={height} aria-hidden className="overflow-visible">
      <path
        d={`${d}L${lx},${height}L2,${height}Z`}
        fill={color}
        opacity={0.12}
      />
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lx} cy={ly} r={3} fill={color} />
    </svg>
  );
};
