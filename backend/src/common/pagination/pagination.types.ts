export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 100;
export const MAX_FILTER_VALUES = 50;
export const MAX_SEARCH_LENGTH = 100;

export type SortOrder = 'asc' | 'desc';

export type ListQuery = Record<
    string,
    string | string[] | undefined
>;

export type FilterDefinition =
    | {
  type:
      | 'string'
      | 'uuid'
      | 'number'
      | 'boolean'
      | 'date';

  field?: string;
  multiple?: boolean;
}
    | {
  type: 'enum';

  values: readonly string[];

  field?: string;
  multiple?: boolean;
}
    | {
  type: 'dateRange' | 'numberRange';

  field?: string;
};

export type FilterDefinitions =
    Record<string, FilterDefinition>;

type OrderBy<Field extends string> = Partial<
    Record<Field, SortOrder>
>;

export interface PaginateOptions<
    T,
    W extends object,
    S extends string,
    D extends string = S,
> {
  where: W;

  searchFields?: readonly string[];

  filters?: FilterDefinitions;

  sortableFields: readonly S[];

  defaultSort: OrderBy<D>[];

  softDeleteField?: string;

  allowDeletedFilter?: boolean;

  findMany: (args: {
    where: W;
    orderBy: OrderBy<S | D | 'id'>[];
    skip: number;
    take: number;
  }) => Promise<T[]>;

  count: (args: {
    where: W;
  }) => Promise<number>;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  count: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface Paginated<T> {
  data: T[];
  meta: PaginationMeta;
}