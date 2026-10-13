export interface Interval {
  start: number;
  end: number;
}

export function merge(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((interval) => interval.end > interval.start).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

export function subtract(from: readonly Interval[], remove: readonly Interval[]): Interval[] {
  const holes = merge(remove);
  const result: Interval[] = [];
  for (const interval of merge(from)) {
    let cursor = interval.start;
    for (const hole of holes) {
      if (hole.end <= cursor) continue;
      if (hole.start >= interval.end) break;
      if (hole.start > cursor) result.push({ start: cursor, end: hole.start });
      cursor = Math.max(cursor, hole.end);
    }
    if (cursor < interval.end) result.push({ start: cursor, end: interval.end });
  }
  return result;
}

export function clip(intervals: readonly Interval[], window: Interval): Interval[] {
  return intervals
    .map((interval) => ({ start: Math.max(interval.start, window.start), end: Math.min(interval.end, window.end) }))
    .filter((interval) => interval.end > interval.start);
}
