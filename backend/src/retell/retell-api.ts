import { AppError } from '@/common/errors/app-error';

export const RETELL_API = 'https://api.retellai.com';

/**
 * A Retell call that throws an UPSTREAM_ERROR with the provider's own message
 * on failure, worded like telnyx() so the call worker reads a 429 alike.
 */
export async function retell<T = any>(apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${RETELL_API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new AppError('UPSTREAM_ERROR', `Retell unreachable: ${(error as Error).message}`);
  }
  if (!res.ok) {
    const text = await res.text();
    // Retell answers { status: "error", message }; its message is what the owner needs to read.
    let detail = text;
    try {
      detail = (JSON.parse(text) as { message?: unknown }).message?.toString() || text;
    } catch {
      // not JSON: keep the raw text
    }
    throw new AppError('UPSTREAM_ERROR', `Retell ${init.method ?? 'GET'} ${path.split('?')[0]} failed ${res.status}: ${detail.slice(0, 300)}`);
  }
  return (res.status === 204 ? {} : await res.json()) as T;
}

/** Retell rate-limited the workspace: wait before the next request. */
export const isRetellRateLimited = (error: unknown): boolean => error instanceof Error && /failed 429\b/.test(error.message);

/** Recording off = Retell keeps no transcript or recording either, only what scoring needs. */
export const storageFor = (record: boolean) => (record ? 'everything' : 'basic_attributes_only');

export interface RetellLlmTool {
  type?: string;
  name?: string;
  url?: string;
  [key: string]: unknown;
}

/**
 * One read and one write of a Retell LLM's tools and prompt; refuses to write
 * when the current prompt cannot be read, so a prompt is never wiped by mistake.
 * `edit` returns the patch, or null to leave the LLM as it is.
 */
export async function editRetellLlm(
  apiKey: string,
  llmId: string,
  edit: (tools: RetellLlmTool[], prompt: string) => Record<string, unknown> | null,
): Promise<boolean> {
  const llm = await retell<{ general_tools?: RetellLlmTool[] | null; general_prompt?: unknown }>(apiKey, `/get-retell-llm/${llmId}`);
  if (typeof llm.general_prompt !== 'string') throw new AppError('UPSTREAM_ERROR', 'Could not read the agent prompt from Retell; it was left unchanged.');
  const patch = edit(llm.general_tools ?? [], llm.general_prompt);
  if (!patch) return false;
  await retell(apiKey, `/update-retell-llm/${llmId}`, { method: 'PATCH', body: JSON.stringify(patch) });
  return true;
}
