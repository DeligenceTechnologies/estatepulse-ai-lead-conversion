/**
 * A calendar connection whose credentials Nango holds (connected from the
 * Integrations page) stores, in its `credentials` column, only a reference to
 * the Nango connection instead of a sealed key. The reference is not a secret:
 * using it needs this server's Nango API key.
 */
export interface NangoReference {
  providerConfigKey: string;
  connectionId: string;
}

const PREFIX = 'nango:v1:';

export function nangoReference(ref: NangoReference): string {
  return PREFIX + JSON.stringify([ref.providerConfigKey, ref.connectionId]);
}

/** The Nango connection behind stored credentials, or null for credentials sealed by EstatePulse itself. */
export function readNangoReference(credentials: string): NangoReference | null {
  if (!credentials.startsWith(PREFIX)) return null;
  try {
    const value: unknown = JSON.parse(credentials.slice(PREFIX.length));
    if (Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === 'string' && part.length > 0)) {
      return { providerConfigKey: value[0] as string, connectionId: value[1] as string };
    }
  } catch {
    // Not a reference we wrote.
  }
  return null;
}
