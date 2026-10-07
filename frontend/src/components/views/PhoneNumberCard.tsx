import React, { useState } from 'react';
import { Phone, Search, Loader2, AlertTriangle, CheckCircle2, ShoppingCart } from 'lucide-react';
import {
  TelnyxStatus,
  AvailableNumber,
  OwnedNumber,
  searchNumbers,
  listOwnedNumbers,
  buyNumber,
  assignNumber,
  unassignNumber,
} from '../../utils/assistantApi';

// Phone number provisioning: search & preview, buy, or assign an existing number.
export const PhoneNumberCard: React.FC<{ status: TelnyxStatus; onChange: () => void }> = ({ status, onChange }) => {
  const [tab, setTab] = useState<'search' | 'owned'>('search');
  const [area, setArea] = useState('');
  const [wantVoice, setWantVoice] = useState(true);
  const [wantSms, setWantSms] = useState(true);
  const [available, setAvailable] = useState<AvailableNumber[] | null>(null);
  const [owned, setOwned] = useState<OwnedNumber[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const features = [wantVoice ? 'voice' : '', wantSms ? 'sms' : ''].filter(Boolean).join(',');

  const search = async () => {
    setBusy('search'); setError(null); setNote(null);
    try {
      setAvailable(await searchNumbers({ country: 'US', area: area || undefined, features, limit: 10 }));
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const loadOwned = async () => {
    setBusy('owned'); setError(null);
    try { setOwned(await listOwnedNumbers()); } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const buyAndUse = async (n: AvailableNumber) => {
    setBusy(n.phone_number); setError(null); setNote(null);
    try {
      await buyNumber(n.phone_number);
      setNote(`Purchased ${n.phone_number} — assigning to your assistant…`);
      await assignNumber(n.phone_number);
      onChange();
      setNote(`${n.phone_number} is now your active number.`);
      setAvailable((a) => (a ? a.filter((x) => x.phone_number !== n.phone_number) : a));
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const useOwned = async (n: OwnedNumber) => {
    setBusy(n.phone_number); setError(null); setNote(null);
    try { await assignNumber(n.phone_number); onChange(); setNote(`${n.phone_number} is now your active number.`); }
    catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const disconnect = async (phone: string) => {
    setBusy(phone); setError(null); setNote(null);
    try { await unassignNumber(phone); onChange(); setNote(`${phone} disconnected.`); }
    catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const cost = (n: AvailableNumber) => {
    const up = n.upfront_cost ? `$${n.upfront_cost}` : '';
    const mo = n.monthly_cost ? `$${n.monthly_cost}/mo` : '';
    return [up, mo].filter(Boolean).join(' + ') || '—';
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Phone className="w-4 h-4 text-emerald-400" />
          Phone Number
        </h3>
        <span className="text-xs text-slate-400 flex items-center gap-2">
          {status.fromNumber ? (
            <>
              <span className="text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Active: {status.fromNumber}</span>
              <button type="button" onClick={() => disconnect(status.fromNumber)} disabled={busy !== null} className="text-rose-400 hover:text-rose-300 font-semibold disabled:opacity-50">Disconnect</button>
            </>
          ) : 'No number assigned yet'}
        </span>
      </div>

      <div className="flex gap-2 text-xs">
        <button type="button" onClick={() => setTab('search')} className={`px-3 py-1 rounded-lg font-semibold ${tab === 'search' ? 'bg-emerald-600/20 text-emerald-300' : 'text-slate-400 hover:text-slate-200'}`}>Search &amp; buy</button>
        <button type="button" onClick={() => { setTab('owned'); if (!owned) loadOwned(); }} className={`px-3 py-1 rounded-lg font-semibold ${tab === 'owned' ? 'bg-emerald-600/20 text-emerald-300' : 'text-slate-400 hover:text-slate-200'}`}>My numbers</button>
      </div>

      {error && <div className="flex items-center gap-1.5 text-xs text-rose-300 bg-rose-950/40 border border-rose-900/40 rounded-lg px-3 py-1.5"><AlertTriangle className="w-3.5 h-3.5" /> {error}</div>}
      {note && <div className="flex items-center gap-1.5 text-xs text-emerald-300"><CheckCircle2 className="w-3.5 h-3.5" /> {note}</div>}

      {tab === 'search' && (
        <div className="space-y-3">
          <div className="flex items-end gap-2 flex-wrap text-xs">
            <div>
              <label className="block text-slate-400 mb-1">Area code</label>
              <input value={area} onChange={(e) => setArea(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="512" className="w-24 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-white focus:outline-none focus:border-emerald-500" />
            </div>
            <label className="flex items-center gap-1.5 text-slate-300"><input type="checkbox" checked={wantVoice} onChange={(e) => setWantVoice(e.target.checked)} /> Voice</label>
            <label className="flex items-center gap-1.5 text-slate-300"><input type="checkbox" checked={wantSms} onChange={(e) => setWantSms(e.target.checked)} /> SMS</label>
            <button type="button" onClick={search} disabled={busy !== null} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-on-accent rounded-lg font-bold flex items-center gap-1.5">
              {busy === 'search' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />} Search
            </button>
          </div>

          {available && available.length === 0 && <p className="text-xs text-slate-500">No numbers matched — try a different area code or fewer features.</p>}
          <div className="space-y-1.5">
            {(available || []).map((n) => (
              <div key={n.phone_number} className="flex items-center justify-between bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-xs">
                <div>
                  <span className="font-mono text-white">{n.phone_number}</span>
                  <span className="text-slate-500 ml-2">{n.region}</span>
                  <span className="text-slate-600 ml-2">{n.features.join(', ')}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-slate-400">{cost(n)}</span>
                  <button type="button" onClick={() => buyAndUse(n)} disabled={busy !== null} className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-on-accent rounded-lg font-bold flex items-center gap-1.5">
                    {busy === n.phone_number ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShoppingCart className="w-3.5 h-3.5" />} Buy &amp; use
                  </button>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500">Buying charges your Telnyx account. Numbers are previewed here — nothing is purchased until you click Buy.</p>
        </div>
      )}

      {tab === 'owned' && (
        <div className="space-y-1.5">
          {busy === 'owned' && <p className="text-xs text-slate-400 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading your numbers…</p>}
          {owned && owned.length === 0 && <p className="text-xs text-slate-500">You don't own any numbers yet — search and buy one.</p>}
          {(owned || []).map((n) => (
            <div key={n.id} className="flex items-center justify-between bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-xs">
              <span className="font-mono text-white">{n.phone_number}</span>
              {status.fromNumber === n.phone_number ? (
                <button type="button" onClick={() => disconnect(n.phone_number)} disabled={busy !== null} className="px-3 py-1 border border-rose-900/50 text-rose-400 hover:text-rose-300 disabled:opacity-50 rounded-lg font-bold">
                  {busy === n.phone_number ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Disconnect'}
                </button>
              ) : (
                <button type="button" onClick={() => useOwned(n)} disabled={busy !== null} className="px-3 py-1 border border-slate-700 hover:border-slate-500 disabled:opacity-50 text-white rounded-lg font-bold">
                  {busy === n.phone_number ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Connect'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
