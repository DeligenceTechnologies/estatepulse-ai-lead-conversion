import {
  DEFAULT_PAGE_SIZE,
  MAX_FILTER_VALUES,
  MAX_PAGE_SIZE,
  MAX_SEARCH_LENGTH,
  type FilterDefinition,
  type FilterDefinitions,
  type ListQuery,
  type SortOrder,
} from './pagination.types';

const UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_STRING_LENGTH = 200;

type ParseResult =
    | { ok: true; value: unknown }
    | { ok: false; error: string };

export interface ParsedPage {
  page: number;
  limit: number;
}

export interface ParsedSort {
  sortBy?: string;
  sortOrder?: SortOrder;
}

export const nest = (
    path: string,
    value: unknown,
): Record<string, unknown> => {
  return path
      .split('.')
      .reduceRight(
          (result, key) => ({ [key]: result }),
          value,
      ) as Record<string, unknown>;
};

function getSingleValue(
    value: string | string[] | undefined,
): string | undefined {
  const raw = Array.isArray(value)
      ? value[value.length - 1]
      : value;

  const trimmed = raw?.trim();

  return trimmed || undefined;
}

function getMultipleValues(
    value: string | string[] | undefined,
): string[] {
  if (value === undefined) {
    return [];
  }

  const values = Array.isArray(value) ? value : [value];

  return values
      .flatMap((item) => item.split(','))
      .map((item) => item.trim())
      .filter(Boolean);
}

function parseNumber(
    value: string,
    field: string,
): ParseResult {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return {
      ok: false,
      error: `${field} must be a number`,
    };
  }

  return {
    ok: true,
    value: number,
  };
}

function parseBoolean(
    value: string,
    field: string,
): ParseResult {
  if (value === 'true' || value === '1') {
    return {
      ok: true,
      value: true,
    };
  }

  if (value === 'false' || value === '0') {
    return {
      ok: true,
      value: false,
    };
  }

  return {
    ok: false,
    error: `${field} must be true or false`,
  };
}

function parseDate(
    value: string,
    field: string,
): ParseResult {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return {
      ok: false,
      error: `${field} must be a valid date`,
    };
  }

  return {
    ok: true,
    value: date,
  };
}

function parseUuid(
    value: string,
    field: string,
): ParseResult {
  if (!UUID_REGEX.test(value)) {
    return {
      ok: false,
      error: `${field} must be a valid UUID`,
    };
  }

  return {
    ok: true,
    value,
  };
}

function parseEnum(
    value: string,
    definition: Extract<FilterDefinition, { type: 'enum' }>,
    field: string,
): ParseResult {
  if (!definition.values.includes(value)) {
    return {
      ok: false,
      error: `${field} must be one of: ${definition.values.join(', ')}`,
    };
  }

  return {
    ok: true,
    value,
  };
}

function parseString(
    value: string,
    field: string,
): ParseResult {
  if (value.length > MAX_STRING_LENGTH) {
    return {
      ok: false,
      error: `${field} must be at most ${MAX_STRING_LENGTH} characters`,
    };
  }

  return {
    ok: true,
    value,
  };
}

function castValue(
    value: string,
    definition: FilterDefinition,
    field: string,
): ParseResult {
  switch (definition.type) {
    case 'uuid':
      return parseUuid(value, field);

    case 'number':
    case 'numberRange':
      return parseNumber(value, field);

    case 'boolean':
      return parseBoolean(value, field);

    case 'date':
    case 'dateRange':
      return parseDate(value, field);

    case 'enum':
      return parseEnum(value, definition, field);

    case 'string':
      return parseString(value, field);
  }
}

function parsePositiveInteger(
    query: ListQuery,
    field: string,
    fallback: number,
    errors: string[],
    max?: number,
): number {
  const raw = getSingleValue(query[field]);

  if (raw === undefined) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1) {
    errors.push(`${field} must be a positive whole number`);
    return fallback;
  }

  if (max !== undefined && value > max) {
    errors.push(`${field} must not be greater than ${max}`);
    return fallback;
  }

  return value;
}

export function parsePage(
    query: ListQuery,
    errors: string[],
): ParsedPage {
  return {
    page: parsePositiveInteger(
        query,
        'page',
        1,
        errors,
    ),
    limit: parsePositiveInteger(
        query,
        'limit',
        DEFAULT_PAGE_SIZE,
        errors,
        MAX_PAGE_SIZE,
    ),
  };
}

export function parseSort(
    query: ListQuery,
    sortableFields: readonly string[],
    errors: string[],
): ParsedSort {
  const sortBy = getSingleValue(query.sortBy);
  const sortOrder = getSingleValue(query.sortOrder)?.toLowerCase();

  if (
      sortBy !== undefined &&
      !sortableFields.includes(sortBy)
  ) {
    errors.push(
        sortableFields.length > 0
            ? `sortBy must be one of: ${sortableFields.join(', ')}`
            : 'This list cannot be sorted',
    );
  }

  if (
      sortOrder !== undefined &&
      sortOrder !== 'asc' &&
      sortOrder !== 'desc'
  ) {
    errors.push('sortOrder must be asc or desc');
  }

  return {
    sortBy:
        sortBy && sortableFields.includes(sortBy)
            ? sortBy
            : undefined,

    sortOrder:
        sortOrder === 'asc' || sortOrder === 'desc'
            ? sortOrder
            : undefined,
  };
}

export function parseSearch(
    query: ListQuery,
    searchFields: readonly string[],
    errors: string[],
): string | undefined {
  const search = getSingleValue(query.search);

  if (search === undefined) {
    return undefined;
  }

  if (searchFields.length === 0) {
    errors.push('This list does not support search');
    return undefined;
  }

  if (search.length > MAX_SEARCH_LENGTH) {
    errors.push(
        `search must be at most ${MAX_SEARCH_LENGTH} characters`,
    );
    return undefined;
  }

  return search;
}

function parseRangeFilter(
    query: ListQuery,
    key: string,
    definition: FilterDefinition,
    field: string,
    errors: string[],
): Record<string, unknown> | undefined {
  const fromName = `${key}From`;
  const toName = `${key}To`;

  const from = getSingleValue(query[fromName]);
  const to = getSingleValue(query[toName]);

  if (from === undefined && to === undefined) {
    return undefined;
  }

  const range: {
    gte?: unknown;
    lte?: unknown;
  } = {};

  if (from !== undefined) {
    const result = castValue(from, definition, fromName);

    if (result.ok) {
      range.gte = result.value;
    } else {
      errors.push(result.error);
    }
  }

  if (to !== undefined) {
    const result = castValue(to, definition, toName);

    if (result.ok) {
      range.lte = result.value;
    } else {
      errors.push(result.error);
    }
  }

  if (
      range.gte != null &&
      range.lte != null &&
      range.gte > range.lte
  ) {
    errors.push(
        `${fromName} must not be after ${toName}`,
    );

    return undefined;
  }

  if (
      range.gte === undefined &&
      range.lte === undefined
  ) {
    return undefined;
  }

  return nest(field, range);
}

function parseSingleOrMultipleFilter(
    query: ListQuery,
    key: string,
    definition: FilterDefinition,
    field: string,
    errors: string[],
): Record<string, unknown> | undefined {
  const multiple =
      'multiple' in definition &&
      definition.multiple === true;

  const rawValues = multiple
      ? getMultipleValues(query[key])
      : [getSingleValue(query[key])].filter(
          (value): value is string => value !== undefined,
      );

  if (rawValues.length === 0) {
    return undefined;
  }

  if (rawValues.length > MAX_FILTER_VALUES) {
    errors.push(
        `${key} accepts at most ${MAX_FILTER_VALUES} values`,
    );
    return undefined;
  }

  const values: unknown[] = [];

  for (const value of rawValues) {
    const result = castValue(
        value,
        definition,
        key,
    );

    if (!result.ok) {
      errors.push(result.error);
      continue;
    }

    values.push(result.value);
  }

  if (values.length !== rawValues.length) {
    return undefined;
  }

  return nest(
      field,
      multiple
          ? { in: values }
          : values[0],
  );
}

export function parseFilters(
    query: ListQuery,
    filters: FilterDefinitions,
    errors: string[],
): Record<string, unknown>[] {
  const conditions: Record<string, unknown>[] = [];

  for (const [key, definition] of Object.entries(filters)) {
    const field = definition.field ?? key;

    const condition =
        definition.type === 'dateRange' ||
        definition.type === 'numberRange'
            ? parseRangeFilter(
                query,
                key,
                definition,
                field,
                errors,
            )
            : parseSingleOrMultipleFilter(
                query,
                key,
                definition,
                field,
                errors,
            );

    if (condition) {
      conditions.push(condition);
    }
  }

  return conditions;
}

export function knownParams(
    filters: FilterDefinitions,
    allowDeletedFilter: boolean,
): Set<string> {
  const known = new Set([
    'page',
    'limit',
    'sortBy',
    'sortOrder',
    'search',
  ]);

  if (allowDeletedFilter) {
    known.add('deleted');
  }

  for (const [key, definition] of Object.entries(filters)) {
    if (
        definition.type === 'dateRange' ||
        definition.type === 'numberRange'
    ) {
      known.add(`${key}From`);
      known.add(`${key}To`);
    } else {
      known.add(key);
    }
  }

  return known;
}

export function parseDeleted(
    query: ListQuery,
    errors: string[],
): boolean {
  const value = getSingleValue(query.deleted);

  if (
      value === undefined ||
      value === 'false' ||
      value === '0'
  ) {
    return false;
  }

  if (value === 'true' || value === '1') {
    return true;
  }

  errors.push('deleted must be true or false');

  return false;
}