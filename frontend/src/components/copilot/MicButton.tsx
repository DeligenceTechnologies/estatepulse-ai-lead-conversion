import React, { useEffect, useRef, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { IconButton } from '../common/Button';

interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

type RecognitionCtor = new () => Recognition;

const RecognitionImpl: RecognitionCtor | undefined =
  typeof window === 'undefined'
    ? undefined
    : ((window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition);

interface MicButtonProps {
  onStart: () => void;
  /** Called with the full transcript so far, so the input shows it before anything is sent. */
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

/** Push to talk: speech fills the input; the user still reviews and sends it. */
export const MicButton: React.FC<MicButtonProps> = ({ onStart, onTranscript, disabled }) => {
  const [listening, setListening] = useState(false);
  const [denied, setDenied] = useState(false);
  const recognition = useRef<Recognition | null>(null);

  useEffect(() => () => recognition.current?.abort(), []);

  if (!RecognitionImpl) return null;

  const toggle = () => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const r = new RecognitionImpl();
    r.lang = navigator.language || 'en-IN';
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (e) => {
      const text = Array.from(e.results)
        .map((result) => result[0]?.transcript ?? '')
        .join(' ')
        .trim();
      onTranscript(text);
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setDenied(true);
    };
    r.onend = () => setListening(false);
    recognition.current = r;
    onStart();
    r.start();
    setListening(true);
  };

  return (
    <IconButton
      onClick={toggle}
      disabled={disabled || denied}
      aria-label={denied ? 'Microphone blocked in browser settings' : listening ? 'Stop listening' : 'Speak'}
      aria-pressed={listening}
      className={listening ? 'text-emerald-400 animate-pulse' : ''}
      icon={denied ? <MicOff /> : <Mic />}
    />
  );
};
