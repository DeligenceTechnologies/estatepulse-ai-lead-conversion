import { apiFetch, apiUpload } from '../lib/api';

/**
 * The documents and websites the AI looks answers up in. They live in the
 * organization's own Telnyx account, which reads them and searches them during
 * a call or a text chat; EstatePulse only adds, lists and removes them.
 */

export type KnowledgeSourceStatus = 'processing' | 'ready' | 'failed';

export interface KnowledgeSource {
  name: string;
  kind: 'file' | 'website';
  status: KnowledgeSourceStatus;
  error: string | null;
}

export interface KnowledgeSourcesStatus {
  /** False until Telnyx is connected and the organization has an assistant. */
  available: boolean;
  /** The knowledge base is a shared Telnyx tool; only the Telnyx portal can change it. */
  managedInTelnyx: boolean;
  sources: KnowledgeSource[];
  limits: { maxFileBytes: number; fileTypes: string[] };
}

const BASE = '/knowledge/sources';

export const getKnowledgeSources = () => apiFetch<KnowledgeSourcesStatus>(BASE, { auth: true });

export const addKnowledgeWebsite = (url: string) =>
  apiFetch<KnowledgeSourcesStatus>(`${BASE}/website`, { method: 'POST', auth: true, body: { url: url.trim() } });

export const uploadKnowledgeFile = (file: File, onProgress?: (fraction: number) => void) => {
  const form = new FormData();
  form.append('file', file, file.name);
  return apiUpload<KnowledgeSourcesStatus>(`${BASE}/file`, form, onProgress);
};

export const removeKnowledgeSource = (name: string) =>
  apiFetch<KnowledgeSourcesStatus>(`${BASE}?name=${encodeURIComponent(name)}`, { method: 'DELETE', auth: true });
