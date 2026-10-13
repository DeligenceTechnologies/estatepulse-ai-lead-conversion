const REQUEST_TIMEOUT_MS = 15_000;

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }

  get credentialRejected(): boolean {
    return this.status === 401;
  }
}

export async function requestJson<T>(provider: string, url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new ProviderHttpError(provider, 0, `${provider} could not be reached. Try again in a moment.`);
  }

  const body = parse(await response.text());
  if (!response.ok) {
    const detail = errorMessage(body) ?? `request failed (${response.status})`;
    throw new ProviderHttpError(provider, response.status, `${provider}: ${detail}`);
  }
  return body as T;
}

function parse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === 'object') {
    const nested = (error as Record<string, unknown>).message;
    if (typeof nested === 'string') return nested;
  }
  for (const key of ['message', 'error_description', 'title', 'error']) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return null;
}
