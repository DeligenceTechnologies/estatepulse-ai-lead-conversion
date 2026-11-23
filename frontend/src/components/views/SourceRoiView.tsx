import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CalendarCheck, CircleDollarSign, Handshake, RefreshCw, Target, Users } from 'lucide-react';
import { toast } from 'react-toastify';
import { useAuth } from '../../context/AuthContext';
import { messageFor } from '../../lib/api';
import { formatDate } from '../../lib/datetime';
import { formatPercent, formatUsd, parseMoney } from '../../lib/money';
import { useLiveQuery } from '../../lib/useLiveQuery';
import { getRoiReport, putSpend, sourceRoiEnabled, type RoiNumbers, type RoiReport, type RoiRow } from '../../utils/sourceRoiApi';
import { Button } from '../common/Button';
import { CostRatesEditor } from '../roi/CostRatesEditor';
import { ComingSoonView } from './ComingSoonView';

export const monthOf = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

/** A month as the report takes it: 'YYYY-MM'. Browsers without a month picker hand over whatever was typed. */
export const isMonth = (value: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

/** `count` months before `month` ('YYYY-MM'). */
export function monthsBefore(month: string, count: number): string {
  const [year, m] = month.split('-').map(Number);
  return monthOf(new Date(year, m - 1 - count, 1));
}

/** 'November 2026' for '2026-11'. */
export function monthLabel(month: string): string {
  const [year, m] = month.split('-').map(Number);
  return new Date(year, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

const monthInput =
  'bg-slate-950 border border-slate-800 rounded-lg px-2.5 h-9 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 [color-scheme:dark]';

const TILE_TONES = {
  brand: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25',
  sky: 'bg-sky-500/10 text-sky-300 border-sky-500/25',
  rose: 'bg-rose-500/10 text-rose-300 border-rose-500/25',
  violet: 'bg-violet-500/10 text-violet-300 border-violet-500/25',
} as const;

const Tile: React.FC<{ label: string; value: string; hint: string; icon: React.ReactNode; tone: keyof typeof TILE_TONES }> = ({
  label,
  value,
  hint,
  icon,
  tone,
}) => (
  <div className="bg-slate-900/90 border border-slate-800 rounded-2xl px-4 py-3.5 shadow-lg flex items-center gap-3.5 min-w-0">
    <span className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 [&>svg]:w-[18px] [&>svg]:h-[18px] ${TILE_TONES[tone]}`}>
      {icon}
    </span>
    <div className="min-w-0 flex-1">
      <div className="text-2xs font-semibold text-slate-400 truncate">{label}</div>
      <div className="text-2xl font-bold text-white leading-tight tabular-nums">{value}</div>
      <div className="text-2xs text-slate-400 truncate" title={hint}>
        {hint}
      </div>
    </div>
  </div>
);

/** A count with the share of leads it is, e.g. "30 · 75%". */
const withRate = (count: number, rate: number | null): React.ReactNode => (
  <>
    <span className="text-slate-200">{count}</span>
    <span className="text-slate-500"> · {formatPercent(rate)}</span>
  </>
);

const num = 'px-3 py-3 text-right tabular-nums whitespace-nowrap';

/** The money box for one source's spend in the one month shown. Saves when left, or on Enter. */
const SpendCell: React.FC<{ row: RoiRow; month: string; onSaved: () => void }> = ({ row, month, onSaved }) => {
  const shown = row.spend ? String(row.spend) : '';
  const [text, setText] = useState(shown);
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);

  // The box follows the saved amount: after a save, and when another month is picked.
  useEffect(() => setText(shown), [shown, month]);

  const commit = async (): Promise<void> => {
    const amount = parseMoney(text);
    if (amount === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if ((amount ?? 0) === row.spend) return;
    setSaving(true);
    try {
      await putSpend({ leadSourceId: row.sourceId!, month, amount });
      toast.success(amount ? `Spend for ${row.name} saved.` : `Spend for ${row.name} cleared.`);
      onSaved();
    } catch (e) {
      toast.error(messageFor(e));
      setText(shown);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col items-end">
      <div className="relative w-28">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-500 pointer-events-none">$</span>
        <input
          aria-label={`Marketing spend for ${row.name} in ${monthLabel(month)}`}
          aria-invalid={invalid}
          inputMode="decimal"
          placeholder="0"
          value={text}
          disabled={saving}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setText(shown);
              setInvalid(false);
            }
          }}
          className={`w-full bg-slate-950 border rounded-lg pl-6 pr-2 h-8 text-xs text-right text-white tabular-nums placeholder:text-slate-600 focus:outline-none disabled:opacity-60 ${
            invalid ? 'border-rose-500/70 focus:border-rose-400' : 'border-slate-800 focus:border-emerald-500'
          }`}
        />
      </div>
      {invalid && <span className="text-2xs text-rose-300 mt-1">Enter an amount, e.g. 1500</span>}
    </div>
  );
};

const HEADERS: { label: string; title: string; left?: boolean }[] = [
  { label: 'Lead source', title: 'Where the leads came from', left: true },
  { label: 'Leads', title: 'Leads that arrived in the months shown' },
  { label: 'Contacted', title: 'Leads who answered a call or replied to a text, and their share of all leads' },
  { label: 'Qualified', title: 'Leads the AI scored hot or warm, and their share of all leads' },
  { label: 'Appts booked', title: 'Leads who booked at least one appointment' },
  { label: 'Appts held', title: 'Leads whose appointment time has passed without being cancelled or marked a no-show' },
  { label: 'Marketing spend', title: 'What you spent on this source in the months shown' },
  { label: 'AI & comm. cost', title: 'Estimated cost of the AI calls and texts these leads took' },
  { label: 'Cost / appt', title: 'Marketing spend plus AI and communication cost, divided by appointments booked' },
  { label: 'Won', title: 'Leads whose deal was marked won' },
  { label: 'Cost / closing', title: 'Marketing spend plus AI and communication cost, divided by deals won' },
  { label: 'Revenue', title: 'Total value of the deals won' },
];

const Numbers: React.FC<{ n: RoiNumbers; spend: React.ReactNode }> = ({ n, spend }) => (
  <>
    <td className={num}>{n.leads}</td>
    <td className={num}>{withRate(n.contacted, n.contactRate)}</td>
    <td className={num}>{withRate(n.qualified, n.qualificationRate)}</td>
    <td className={num}>{n.booked}</td>
    <td className={num} title={n.noShow ? `${n.noShow} no-show${n.noShow === 1 ? '' : 's'}` : undefined}>
      {n.held}
      {n.noShow > 0 && <span className="text-slate-500"> · {n.noShow} no-show</span>}
    </td>
    <td className={num}>{spend}</td>
    <td className={num}>{formatUsd(n.commCost)}</td>
    <td className={`${num} font-semibold text-white`}>{formatUsd(n.costPerAppointment)}</td>
    <td className={num}>{n.won}</td>
    <td className={`${num} font-semibold text-white`}>{formatUsd(n.costPerClosing)}</td>
    <td className={num}>{n.won ? formatUsd(n.revenue) : formatUsd(null)}</td>
  </>
);

/** The page body, once the server has said Source ROI is on. Exported for its spec. */
export const SourceRoiReport: React.FC<{ canEdit: boolean }> = ({ canEdit }) => {
  // Opens on this month alone: a single month is where spend is typed in, and that is the first thing to do here.
  const thisMonth = monthOf(new Date());
  const [to, setTo] = useState(thisMonth);
  const [from, setFrom] = useState(thisMonth);

  const load = useCallback(() => getRoiReport(from, to), [from, to]);
  const query = useLiveQuery<RoiReport>(load, {
    baseIntervalMs: 60_000,
    maxIntervalMs: 300_000,
    enabled: from <= to,
    refreshKey: `${from}:${to}`,
  });
  const { error, refreshing, stale } = query;
  // An answer for other months than the ones picked (a request that was still on its way when the
  // range changed) is not shown: spend typed against it would be saved to the wrong month.
  const data = query.data && query.data.from === from && query.data.to === to ? query.data : null;
  const refreshQuery = query.refresh;
  // A refresh asked for while a poll is on its way is dropped, and that poll may have been read
  // before the save: ask again shortly after, so the totals always catch up with what was typed.
  const refresh = useCallback(() => {
    refreshQuery();
    window.setTimeout(refreshQuery, 1500);
  }, [refreshQuery]);

  const oneMonth = from === to;
  const totals = data?.totals;
  const hasLeads = (totals?.leads ?? 0) > 0;

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto text-slate-100">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Source ROI</h2>
          <p className="text-xs text-slate-400 mt-0.5 max-w-2xl">
            What each lead source costs you per appointment and per closing. Leads are counted in the month they arrived,
            with everything they did afterwards.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="text-2xs font-semibold text-slate-400">
            <span className="block mb-1">From</span>
            <input type="month" className={monthInput} value={from} max={to} onChange={(e) => isMonth(e.target.value) && setFrom(e.target.value)} />
          </label>
          <label className="text-2xs font-semibold text-slate-400">
            <span className="block mb-1">To</span>
            <input type="month" className={monthInput} value={to} min={from} max={thisMonth} onChange={(e) => isMonth(e.target.value) && e.target.value <= thisMonth && setTo(e.target.value)} />
          </label>
          <Button
            variant="ghost"
            onClick={() => {
              setFrom(monthsBefore(thisMonth, 2));
              setTo(thisMonth);
            }}
          >
            Last 3 months
          </Button>
          <Button variant="outline" onClick={refresh} loading={refreshing} icon={<RefreshCw />}>
            Refresh
          </Button>
        </div>
      </div>

      {from > to ? (
        <p className="text-xs text-amber-300">The first month must not be after the last.</p>
      ) : stale ? (
        <div className="flex items-center gap-2 text-xs text-amber-300/90 px-1">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>Showing the last data we loaded. ({error})</span>
        </div>
      ) : (
        error && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
            <div className="text-xs text-rose-200 leading-relaxed flex-1">
              <div className="font-semibold text-rose-100">Could not load Source ROI</div>
              {error}
            </div>
            <Button variant="link" onClick={refresh}>
              Try again
            </Button>
          </div>
        )
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
        {totals ? (
          <>
            <Tile
              label="Leads"
              value={String(totals.leads)}
              hint={`${formatPercent(totals.contactRate)} contacted · ${formatPercent(totals.qualificationRate)} qualified`}
              icon={<Users />}
              tone="sky"
            />
            <Tile
              label="Total cost"
              value={formatUsd(totals.totalCost)}
              hint={`${formatUsd(totals.spend)} marketing · ${formatUsd(totals.commCost)} AI & comm. (est.)`}
              icon={<CircleDollarSign />}
              tone="rose"
            />
            <Tile
              label="Appointments booked"
              value={String(totals.booked)}
              hint={`${totals.held} held${totals.noShow ? ` · ${totals.noShow} no-show` : ''}`}
              icon={<CalendarCheck />}
              tone="violet"
            />
            <Tile
              label="Cost per appointment"
              value={formatUsd(totals.costPerAppointment)}
              hint={totals.booked ? 'Total cost ÷ appointments booked' : 'No appointments booked yet'}
              icon={<Target />}
              tone="brand"
            />
            <Tile
              label="Cost per closing"
              value={formatUsd(totals.costPerClosing)}
              hint={totals.won ? `${totals.won} won · ${formatUsd(totals.revenue)} revenue` : 'No deals marked won yet'}
              icon={<Handshake />}
              tone="brand"
            />
          </>
        ) : (
          Array.from({ length: 5 }, (_, i) => (
            <div key={i} aria-hidden="true" className="h-[74px] rounded-2xl bg-slate-900/90 border border-slate-800 animate-pulse" />
          ))
        )}
      </div>

      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950/60 text-slate-500 uppercase font-semibold text-2xs tracking-wider border-b border-slate-800">
              <tr>
                {HEADERS.map((h) => (
                  <th key={h.label} title={h.title} className={`px-3 py-2.5 whitespace-nowrap ${h.left ? 'pl-4' : 'text-right'}`}>
                    {h.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {data === null ? (
                Array.from({ length: 4 }, (_, i) => (
                  <tr key={i} aria-hidden="true" className="animate-pulse">
                    <td className="pl-4 px-3 py-3.5">
                      <div className="h-3.5 w-32 rounded bg-slate-800" />
                    </td>
                    {Array.from({ length: HEADERS.length - 1 }, (_, j) => (
                      <td key={j} className="px-3 py-3.5">
                        <div className="h-3.5 w-12 ml-auto rounded bg-slate-800/80" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : data.rows.length === 0 ? (
                <tr>
                  <td colSpan={HEADERS.length} className="px-4 py-12 text-center text-slate-500">
                    No lead sources yet. Connect one under Lead Integrations and its leads will be counted here.
                  </td>
                </tr>
              ) : (
                data.rows.map((row) => (
                  <tr key={row.sourceId ?? 'manual'} className="hover:bg-slate-800/30">
                    <td className="pl-4 px-3 py-3 min-w-40">
                      <div className="font-semibold text-slate-100 truncate max-w-56" title={row.name}>
                        {row.name}
                      </div>
                      {row.archived && <div className="text-2xs text-slate-500">Removed source</div>}
                      {row.sourceId === null && <div className="text-2xs text-slate-500">No source to spend on</div>}
                    </td>
                    <Numbers
                      n={row}
                      spend={
                        canEdit && oneMonth && row.spendEditable ? (
                          <SpendCell row={row} month={from} onSaved={refresh} />
                        ) : row.sourceId === null ? (
                          formatUsd(null)
                        ) : (
                          formatUsd(row.spend)
                        )
                      }
                    />
                  </tr>
                ))
              )}
            </tbody>
            {data && data.rows.length > 1 && (
              <tfoot className="border-t border-slate-700 bg-slate-950/40 text-slate-200">
                <tr>
                  <td className="pl-4 px-3 py-3 font-bold text-white">All sources</td>
                  <Numbers n={data.totals} spend={formatUsd(data.totals.spend)} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <div className="text-xs text-slate-500 leading-relaxed space-y-1 px-1">
        {canEdit && !oneMonth && <p>To enter or change marketing spend, set From and To to the same month.</p>}
        {canEdit && oneMonth && <p>Type what you spent on each source in {monthLabel(from)}; it saves when you leave the box.</p>}
        {data && !hasLeads && <p>No leads arrived in these months.</p>}
        <p>
          AI and communication cost is an estimate.
          {data?.appointmentsTrackedSince
            ? ` Appointments are counted from ${formatDate(data.appointmentsTrackedSince, { month: 'short', day: 'numeric', year: 'numeric' })}, the earliest one on record.`
            : ''}{' '}
          Won deals and their value come from "Mark outcome" on a lead.
        </p>
      </div>

      <CostRatesEditor canEdit={canEdit} onSaved={refresh} />
    </div>
  );
};

/**
 * Source ROI, the owner's page. Until the server answers whether the feature
 * is on, nothing is drawn; where it is off this is still the "Coming Soon"
 * page it replaced, so an old /analytics link behaves as it always did.
 */
export const SourceRoiView: React.FC = () => {
  const { can } = useAuth();
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    void sourceRoiEnabled().then((on) => alive && setEnabled(on));
    return () => {
      alive = false;
    };
  }, []);

  if (enabled === null) return null;
  if (!enabled || !can('report.read')) return <ComingSoonView title="Analytics & ROI" />;
  return <SourceRoiReport canEdit={can('report.update')} />;
};
