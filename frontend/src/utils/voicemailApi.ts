import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';

/**
 * How an AI call treats an answering machine. With detection on, the assistant
 * never talks to a machine: the message is spoken after the beep (or the call
 * hangs up), and the call counts as not answered. With it off, nothing is
 * charged for detection and the assistant starts as soon as the call connects.
 */
export interface VoicemailStatus {
  /** Answering-machine detection on every AI call. */
  detect: boolean;
  /** With detection on: leave the message after the beep; off, hang up. */
  enabled: boolean;
  /** {{firstName}}, {{brokerage}} and the other lead variables are filled in per call. */
  message: string;
  defaultMessage: string;
  /** What Telnyx charges per call for detection, in US dollars. */
  detectionPricePerCall: number;
}

let cached: Promise<VoicemailStatus> | null = null;

export const getVoicemail = (): Promise<VoicemailStatus> => {
  cached = apiFetch<VoicemailStatus>('/voicemail', { auth: true });
  cached.catch(() => {
    cached = null;
  });
  return cached;
};

/** An empty message restores the default one. */
export const updateVoicemail = async (patch: { detect?: boolean; enabled?: boolean; message?: string }) => {
  const next = await apiFetch<VoicemailStatus>('/voicemail', { method: 'PUT', body: patch, auth: true });
  cached = Promise.resolve(next);
  return next;
};

/** Whether AI calls detect answering machines; null until known (or when it cannot be read). */
export function useVoicemailDetection(): boolean | null {
  const [detect, setDetect] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    (cached ?? getVoicemail())
      .then((s) => alive && setDetect(s.detect))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return detect;
}
