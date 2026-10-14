/** A meeting's place, split into a joinable link and anything else (address, phone, note). */
export interface MeetingPlace {
  meetingUrl: string | null;
  location: string | null;
}

/** Only http(s) links are ever shown as "Join", so nothing else can become a clickable href. */
export function webLink(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Picks the join link from the candidates (first web link wins) and keeps the
 * first non-link, human-readable value as the location. Provider codes such as
 * Cal.com's `integrations:daily` are dropped: they mean nothing to a person.
 */
export function meetingPlace(links: (string | null | undefined)[], places: (string | null | undefined)[]): MeetingPlace {
  const meetingUrl = links.map(webLink).find(Boolean) ?? null;
  const location =
    places
      .map((place) => place?.trim())
      .find((place): place is string => Boolean(place) && !webLink(place) && !/^integrations:/i.test(place!)) ?? null;
  return { meetingUrl: meetingUrl ?? places.map(webLink).find(Boolean) ?? null, location };
}

/** A provider colour, only when it is a plain `#rgb` / `#rrggbb` hex (it ends up in a style attribute). */
export function hexColor(value: string | null | undefined): string | null {
  const text = value?.trim().toLowerCase();
  return text && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(text) ? text : null;
}

/** Runs `run` over `items` with at most `limit` in flight, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
