import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Loader2, Mic, Pause, Play, X } from 'lucide-react';
import { toast } from 'react-toastify';
import { ApiError, messageFor } from '../../lib/api';
import { getVoicePreview, sameVoice, type CatalogVoice } from '../../utils/assistantApi';
import { FilterDropdown } from '../common/FilterDropdown';
import { Button, IconButton } from '../common/Button';

/**
 * The AI caller's voice: a dropdown-style button that opens a "Select voice"
 * dialog. In the dialog the admin filters by gender, plays samples and picks
 * one; Save puts it in the form, and the page's "Save changes" applies it.
 *
 * A sample is made by the provider's TTS the first time anyone plays it and
 * cached by the server; here it is kept as a blob URL for the session. A
 * voice id that is not in the list is a custom voice, set under "Advanced".
 */
export const VoicePicker: React.FC<{
  voices: CatalogVoice[];
  /** The Telnyx voice id currently chosen (saved or not). */
  value: string;
  onChange: (telnyxVoiceId: string) => void;
  loading?: boolean;
  onShowAdvanced?: () => void;
  /** A sample failed; the server may have taken that voice off the list, so read it again. */
  onPreviewFailed?: () => void;
}> = ({ voices, value, onChange, loading, onShowAdvanced, onPreviewFailed }) => {
  const [open, setOpen] = useState(false);
  const current = voices.find((v) => sameVoice(v.telnyxVoiceId, value)) ?? null;

  if (loading) {
    return <div className="h-[52px] w-full sm:w-80 rounded-xl border border-slate-800 bg-slate-950/40 animate-pulse" />;
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!voices.length}
        aria-haspopup="dialog"
        className="w-full sm:w-80 flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-left hover:border-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed"
      >
        {current ? <Avatar voice={current} size="sm" /> : <span className="w-8 h-8 shrink-0 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center"><Mic className="w-4 h-4" /></span>}
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-bold text-white truncate">{current ? current.name : value ? 'Custom voice' : 'Choose a voice'}</span>
          <span className="block text-2xs text-slate-400 truncate">{current ? current.description : value ? value : 'Listen to samples and pick one'}</span>
        </span>
        <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
      </button>

      {!voices.length && (
        <p className="text-2xs text-slate-500">
          The voice list could not be loaded. You can still set a voice id under{' '}
          <button type="button" onClick={onShowAdvanced} className="text-emerald-400 hover:underline cursor-pointer">Advanced</button>.
        </p>
      )}
      {voices.length > 0 && !current && value && (
        <p className="text-2xs text-amber-300/90">
          Your agent uses its own voice, not one from the list. It stays until you choose one and Save. You can see it under{' '}
          <button type="button" onClick={onShowAdvanced} className="text-emerald-400 hover:underline cursor-pointer">Advanced</button>.
        </p>
      )}

      {open && (
        <VoiceDialog
          voices={voices}
          value={value}
          onClose={() => setOpen(false)}
          onSave={(id) => {
            onChange(id);
            setOpen(false);
          }}
          onPreviewFailed={onPreviewFailed}
        />
      )}
    </div>
  );
};

const GENDERS = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
];

const VoiceDialog: React.FC<{
  voices: CatalogVoice[];
  value: string;
  onClose: () => void;
  onSave: (telnyxVoiceId: string) => void;
  onPreviewFailed?: () => void;
}> = ({ voices, value, onClose, onSave, onPreviewFailed }) => {
  const [gender, setGender] = useState('');
  const [pending, setPending] = useState<string>(voices.find((v) => sameVoice(v.telnyxVoiceId, value))?.telnyxVoiceId ?? '');
  const player = usePreviewPlayer(onPreviewFailed);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = gender ? voices.filter((v) => v.gender === gender) : voices;
  const chosen = voices.find((v) => sameVoice(v.telnyxVoiceId, pending)) ?? null;
  const changed = !!chosen && !sameVoice(chosen.telnyxVoiceId, value);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-scrim backdrop-blur-[2px] animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-labelledby="voice-dialog-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-4xl max-h-[90vh] flex flex-col bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden text-slate-100">
        <div className="px-5 py-4 bg-slate-950 border-b border-slate-800 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 id="voice-dialog-title" className="text-base font-bold text-white">Select voice</h3>
            <p className="text-xs text-slate-400">The voice your AI caller uses on calls and voicemail. Press play to hear a sample.</p>
          </div>
          <IconButton onClick={onClose} aria-label="Close" className="shrink-0" icon={<X />} />
        </div>

        <div className="px-5 pt-4 pb-3 flex items-center gap-3">
          <FilterDropdown label="Gender" options={GENDERS} value={gender} onChange={setGender} allLabel="All voices" />
          <span className="text-2xs text-slate-500">{shown.length} {shown.length === 1 ? 'voice' : 'voices'}</span>
        </div>

        <div className="px-5 pb-5 overflow-y-auto">
          {shown.length ? (
            <div role="radiogroup" aria-label="Voices" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {shown.map((v) => {
                const on = sameVoice(v.telnyxVoiceId, pending);
                const state = player.stateOf(v.key);
                return (
                  <div
                    key={v.key}
                    className={`flex items-center gap-3 rounded-xl border pr-3 transition-colors ${
                      on ? 'border-emerald-500/70 bg-emerald-500/[0.06] ring-1 ring-emerald-500/40' : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'
                    }`}
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setPending(v.telnyxVoiceId)}
                      className="flex-1 min-w-0 flex items-center gap-3 text-left p-3 rounded-xl cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
                    >
                      <Avatar voice={v} />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5">
                          <span className="text-sm font-bold text-white truncate">{v.name}</span>
                          {on && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" strokeWidth={3} />}
                        </span>
                        <span className="block text-2xs text-slate-400 truncate">{v.description}</span>
                        <span className="block text-2xs text-slate-500 font-mono truncate" title={v.telnyxVoiceId}>ID: {v.telnyxVoiceId}</span>
                      </span>
                    </button>
                    <PlayButton name={v.name} state={state} onClick={() => void player.toggle(v)} />
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-slate-500 py-8 text-center">No {gender} voices in the list.</p>
          )}
        </div>

        <div className="px-5 py-3 bg-slate-950 border-t border-slate-800 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {chosen ? (
              <>
                <Avatar voice={chosen} size="sm" />
                <span className="min-w-0">
                  <span className="block text-xs font-bold text-white truncate">{chosen.name}</span>
                  <span className="block text-2xs text-slate-400 truncate">
                    {chosen.description}
                    {changed && ' · then press Save changes to apply it'}
                  </span>
                </span>
              </>
            ) : (
              <span className="text-2xs text-slate-500">Pick a voice from the list.</span>
            )}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={() => chosen && onSave(chosen.telnyxVoiceId)} disabled={!chosen}>Save</Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};

type PlayState = 'idle' | 'loading' | 'playing';

const PlayButton: React.FC<{ name: string; state: PlayState; onClick: () => void }> = ({ name, state, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={state === 'idle' ? `Play ${name} sample` : `Stop ${name} sample`}
    className={`w-9 h-9 shrink-0 rounded-lg border flex items-center justify-center transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 ${
      state === 'playing' ? 'bg-emerald-500 border-emerald-500 text-slate-950' : 'bg-slate-900 border-slate-700 text-slate-200 hover:bg-slate-800'
    }`}
  >
    {state === 'loading' ? <Loader2 className="w-4 h-4 animate-spin" /> : state === 'playing' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
  </button>
);

/** A round badge with the voice's initial, tinted by gender, in place of a photo. */
const Avatar: React.FC<{ voice: CatalogVoice; size?: 'sm' | 'md' }> = ({ voice, size = 'md' }) => {
  const tint =
    voice.gender === 'female'
      ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
      : voice.gender === 'male'
        ? 'bg-sky-500/15 text-sky-300 border-sky-500/30'
        : 'bg-slate-700/40 text-slate-300 border-slate-600';
  return (
    <span
      aria-hidden
      className={`shrink-0 rounded-full border flex items-center justify-center font-bold ${tint} ${size === 'sm' ? 'w-8 h-8 text-xs' : 'w-11 h-11 text-base'}`}
    >
      {voice.name.charAt(0).toUpperCase()}
    </span>
  );
};

/** One player for every card, so starting a sample stops the one before it. */
function usePreviewPlayer(onFailed?: () => void) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const clips = useRef(new Map<string, string>());
  /** The card asked for last; a slow fetch for an older click must not start playing. */
  const wanted = useRef<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);

  useEffect(() => {
    const urls = clips.current;
    return () => {
      wanted.current = null;
      audio.current?.pause();
      audio.current = null;
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls.clear();
    };
  }, []);

  const stop = () => {
    wanted.current = null;
    audio.current?.pause();
    setPlaying(null);
    setFetching(null);
  };

  const clipFor = async (v: CatalogVoice): Promise<string> => {
    const hit = clips.current.get(v.key);
    if (hit) return hit;
    const { audio: b64, contentType } = await getVoicePreview(v.key);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: contentType || 'audio/mpeg' }));
    clips.current.set(v.key, url);
    return url;
  };

  const toggle = async (v: CatalogVoice) => {
    if (playing === v.key || fetching === v.key) return stop();
    stop();
    wanted.current = v.key;
    if (!audio.current) {
      audio.current = new Audio();
      audio.current.onended = () => setPlaying(null);
    }
    const a = audio.current;
    try {
      if (!clips.current.has(v.key)) setFetching(v.key);
      const url = await clipFor(v);
      if (wanted.current !== v.key) return;
      setFetching(null);
      a.src = url;
      a.currentTime = 0;
      setPlaying(v.key);
      await a.play();
    } catch (error) {
      if (wanted.current !== v.key) return;
      stop();
      // The server words these for the admin (voice not available / try again).
      const text = error instanceof ApiError && error.code === 'UPSTREAM_ERROR' && error.message ? error.message : messageFor(error);
      toast.error(text || `Couldn't play the ${v.name} sample.`);
      onFailed?.();
    }
  };

  const stateOf = (key: string): PlayState => (fetching === key ? 'loading' : playing === key ? 'playing' : 'idle');
  return { toggle, stateOf };
}
