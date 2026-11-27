import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { ArrowUp, Mic, MicOff, Square } from 'lucide-react';
import { IconButton } from '../common/Button';
import { useSpeechInput } from './useSpeechInput';

interface ComposerProps {
  placeholder: string;
  busy: boolean;
  /** Typing is off: the assistant is unavailable or this month's limit is used up. */
  disabled?: boolean;
  /** The home page's empty state gets the big box; a chat in progress the normal one. */
  large?: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** The office's microphone setting (Settings > Ask EstatePulse); on unless turned off. */
  voice?: boolean;
}

/** What a parent may do to the box: put the cursor in it, or listen while a button is held. */
export interface ComposerHandle {
  focus(): void;
  /** Listens until stopVoice(); the words go into the box, not straight to the assistant. */
  startVoice(): void;
  stopVoice(): void;
}

const MAX_CHARS = 4000;

/** The box people type (or speak) into. Enter sends, Shift+Enter adds a line. */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { placeholder, busy, disabled = false, large = false, onSend, onStop, voice = true },
  ref,
) {
  const [value, setValue] = useState('');
  const textRef = useRef<HTMLTextAreaElement>(null);
  // What was typed before the mic started, so speech is added to it rather than replacing it.
  const voiceBase = useRef('');
  const speech = useSpeechInput((text) => setValue(voiceBase.current + text));

  const beginVoice = (continuous: boolean) => {
    if (busy || disabled) return;
    voiceBase.current = value ? `${value.trimEnd()} ` : '';
    speech.start(continuous);
  };

  useImperativeHandle(
    ref,
    () => ({
      focus: () => textRef.current?.focus(),
      startVoice: () => beginVoice(true),
      stopVoice: () => speech.stop(),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value, busy, disabled, speech.start, speech.stop],
  );

  const submit = () => {
    if (!value.trim() || busy || disabled) return;
    speech.stop();
    onSend(value);
    setValue('');
  };

  return (
    <form
      className={`bg-slate-900 border border-slate-700 rounded-2xl shadow-xl focus-within:border-emerald-500/50 ${large ? 'px-4 pt-3.5 pb-2.5' : 'px-3.5 pt-2.5 pb-2'}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="sr-only" htmlFor="assistant-input">
        Message the assistant
      </label>
      <textarea
        id="assistant-input"
        ref={textRef}
        rows={large ? 2 : 1}
        value={value}
        maxLength={MAX_CHARS}
        disabled={disabled}
        placeholder={speech.listening ? 'Listening…' : placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        className="w-full resize-none bg-transparent text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none max-h-40 custom-scrollbar disabled:opacity-60"
      />
      <div className="flex items-center justify-end gap-2 pt-1">
        {voice && speech.supported && (
          <IconButton
            onClick={() => (speech.listening ? speech.stop() : beginVoice(false))}
            disabled={busy || disabled || speech.denied}
            aria-label={speech.denied ? 'Microphone blocked in browser settings' : speech.listening ? 'Stop listening' : 'Speak'}
            aria-pressed={speech.listening}
            className={speech.listening ? 'text-emerald-400 animate-pulse' : ''}
            icon={speech.denied ? <MicOff /> : <Mic />}
          />
        )}
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            title="Stop"
            className="cursor-pointer w-9 h-9 rounded-full border border-slate-700 text-slate-200 hover:bg-slate-800 flex items-center justify-center transition-colors"
          >
            <Square className="w-3.5 h-3.5" fill="currentColor" aria-hidden />
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send"
            title="Send"
            disabled={!value.trim() || disabled}
            className="cursor-pointer w-9 h-9 rounded-full bg-brand-600 text-on-accent hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
          >
            <ArrowUp className="w-4 h-4" aria-hidden />
          </button>
        )}
      </div>
    </form>
  );
});
