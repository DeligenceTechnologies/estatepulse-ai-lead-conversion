import type { NangoService } from '../nango/nango.service';

type Params = Record<string, string | number | string[] | number[]>;

/**
 * One connection's provider API, through Nango's proxy. Nango adds and
 * refreshes the credentials; this process never sees a token. Nango also
 * retries 429s and 5xx with backoff (`retries`), honouring the provider's
 * rate-limit headers, before a NangoError reaches the adapter.
 */
export class ProviderClient {
  constructor(
    private readonly nango: NangoService,
    readonly providerConfigKey: string,
    readonly nangoConnectionId: string,
  ) {}

  get<T>(endpoint: string, params?: Params): Promise<T> {
    return this.nango.proxy<T>({
      method: 'GET',
      endpoint,
      providerConfigKey: this.providerConfigKey,
      connectionId: this.nangoConnectionId,
      ...(params ? { params } : {}),
      retries: 3,
    });
  }

  patch<T>(endpoint: string, data: unknown): Promise<T> {
    return this.nango.proxy<T>({
      method: 'PATCH',
      endpoint,
      providerConfigKey: this.providerConfigKey,
      connectionId: this.nangoConnectionId,
      data,
      // A PATCH sets fields to given values, so repeating it after a lost response is safe.
      retries: 3,
    });
  }

  post<T>(endpoint: string, data: unknown): Promise<T> {
    return this.nango.proxy<T>({
      method: 'POST',
      endpoint,
      providerConfigKey: this.providerConfigKey,
      connectionId: this.nangoConnectionId,
      data,
      retries: 3,
    });
  }
}
