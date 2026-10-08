import { BadRequestException } from '@nestjs/common';
import {
  knownParams,
  nest,
  parseDeleted,
  parseFilters,
  parsePage,
  parseSearch,
  parseSort,
} from './pagination.parser';
import type {
  ListQuery,
  PaginateOptions,
  Paginated,
  SortOrder,
} from './pagination.types';

type OrderBy<S extends string, D extends string> = Partial<
    Record<S | D | 'id', SortOrder>
>;

function validateQueryParams(
    query: ListQuery,
    filters: PaginateOptions<unknown, object, string>['filters'],
    allowDeleted: boolean,
): string[] {
  const known = knownParams(filters ?? {}, allowDeleted);
  const errors: string[] = [];

  for (const param of Object.keys(query)) {
    if (!known.has(param)) {
      errors.push(
          `Unknown query parameter "${param}". Allowed: ${[
            ...known,
          ].join(', ')}`,
      );
    }
  }

  return errors;
}

function buildWhere<W extends object>(
    baseWhere: W,
    filterConditions: Record<string, unknown>[],
    search: string | undefined,
    searchFields: readonly string[],
    softDeleteField: string | undefined,
    showDeleted: boolean,
): W {
  const conditions: Record<string, unknown>[] = [
    baseWhere as Record<string, unknown>,
    ...filterConditions,
  ];

  if (search && searchFields.length > 0) {
    conditions.push({
      OR: searchFields.map((field) =>
          nest(field, {
            contains: search,
            mode: 'insensitive',
          }),
      ),
    });
  }

  if (softDeleteField) {
    conditions.push(
        nest(
            softDeleteField,
            showDeleted
                ? { not: null }
                : null,
        ),
    );
  }

  return { AND: conditions } as W;
}

function buildOrderBy<S extends string, D extends string>(
    sortBy: S | undefined,
    sortOrder: SortOrder | undefined,
    defaultSort: readonly Partial<Record<D, SortOrder>>[],
): OrderBy<S, D>[] {
  const orderBy: OrderBy<S, D>[] = sortBy
      ? [{ [sortBy]: sortOrder ?? 'asc' } as OrderBy<S, D>]
      : defaultSort.map((entry) => ({ ...entry })) as OrderBy<S, D>[];

  if (!orderBy.some((entry) => 'id' in entry)) {
    const primaryDirection =
        Object.values(orderBy[0] ?? {})[0] ?? 'asc';

    orderBy.push({
      id: primaryDirection as SortOrder,
    } as OrderBy<S, D>);
  }

  return orderBy;
}

export async function paginate<
    T,
    W extends object,
    S extends string,
    D extends string = S,
>(
    query: ListQuery,
    options: PaginateOptions<T, W, S, D>,
): Promise<Paginated<T>> {
  const {
    searchFields = [],
    filters = {},
    softDeleteField,
    allowDeletedFilter = false,
  } = options;

  const errors = validateQueryParams(
      query,
      filters,
      allowDeletedFilter && !!softDeleteField,
  );

  const { page, limit } = parsePage(query, errors);

  const { sortBy, sortOrder } = parseSort(
      query,
      options.sortableFields,
      errors,
  );

  const search = parseSearch(
      query,
      searchFields,
      errors,
  );

  const filterConditions = parseFilters(
      query,
      filters,
      errors,
  );

  const showDeleted =
      allowDeletedFilter && softDeleteField
          ? parseDeleted(query, errors)
          : false;

  if (errors.length > 0) {
    throw new BadRequestException(errors);
  }

  const where = buildWhere(
      options.where,
      filterConditions,
      search,
      searchFields,
      softDeleteField,
      showDeleted,
  );

  const orderBy = buildOrderBy(
      sortBy,
      sortOrder,
      options.defaultSort,
  );

  const skip = (page - 1) * limit;

  const [data, total] = await Promise.all([
    options.findMany({
      where,
      orderBy,
      skip,
      take: limit,
    }),
    options.count({
      where,
    }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    data,
    meta: {
      page,
      limit,
      count: data.length,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  };
}