import { useCallback, useEffect, useRef, useState } from 'react';

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

/** The browser's own speech recognition: Chrome, Edge and Safari have it, Firefox does not. */
const RecognitionImpl: RecognitionCtor | undefined =
  typeof window === 'undefined'
    ? undefined
    : ((window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition);

export const speechSupported = (): boolean => Boolean(RecognitionImpl);

/**
 * Speech to text in the browser. Nothing is sent to us: the words land in the input, where the
 * person reads them and presses Send. `continuous` keeps listening through pauses, for
 * hold-to-speak, until `stop()`.
 */
export function useSpeechInput(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [denied, setDenied] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(() => () => recognition.current?.abort(), []);

  const start = useCallback((continuous = false): boolean => {
    if (!RecognitionImpl || recognition.current) return false;
    const r = new RecognitionImpl();
    r.lang = navigator.language || 'en-US';
    r.interimResults = true;
    r.continuous = continuous;
    r.onresult = (e) => {
      const text = Array.from(e.results)
        .map((result) => result[0]?.transcript ?? '')
        .join(' ')
        .trim();
      onTextRef.current(text);
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setDenied(true);
    };
    r.onend = () => {
      setListening(false);
      recognition.current = null;
    };
    recognition.current = r;
    r.start();
    setListening(true);
    return true;
  }, []);

  const stop = useCallback(() => recognition.current?.stop(), []);

  return { supported: Boolean(RecognitionImpl), listening, denied, start, stop };
}
