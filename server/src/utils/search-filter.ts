import { AuthDto } from 'src/dtos/auth.dto';
import { SearchFilter, SearchFilterBranch } from 'src/dtos/search.dto';
import { AssetVisibility } from 'src/enum';
import { isPrivateMode, requireElevatedPermission, requirePrivateMode } from 'src/utils/access';

type EnumField = 'type' | 'visibility';
type EnumOperator = keyof NonNullable<SearchFilterBranch[EnumField]>;
type EnumOperandMap<T> = { eq: T; ne: T; in: T[]; notIn: T[] };
type EnumCondition<T> = { [K in EnumOperator]?: EnumOperandMap<T>[K] };
type IdsFilterField = 'albumIds' | 'personIds' | 'tagIds';

const filterBranches = (filter: SearchFilter): SearchFilterBranch[] => [filter, ...(filter.or ?? [])];

/** Whether a row with `value` can satisfy the condition. A missing operator allows any value. */
const canMatch = <T>(condition: EnumCondition<T>, value: T): boolean => {
  const { eq, ne, in: anyOf, notIn, ...unhandled } = condition;
  // fails to compile when EnumFilter gains an operator this check does not consider
  void (unhandled satisfies Record<string, never>);

  return (
    (eq === undefined || eq === value) &&
    (ne === undefined || ne !== value) &&
    (anyOf === undefined || anyOf.includes(value)) &&
    (notIn === undefined || !notIn.includes(value))
  );
};

/**
 * The conditions that decide which `field` values the filter can return. A top-level condition decides alone, otherwise each branch itself.
 */
const decidingConditions = <F extends EnumField>(filter: SearchFilter, field: F) => {
  if (filter[field] !== undefined) {
    return [filter[field]];
  }

  return filterBranches(filter)
    .map((branch) => branch[field])
    .filter((condition) => condition !== undefined);
};

/**
 * Keeps locked assets out of search results unless the session is elevated: a filter that asks for
 * them is rejected with 401, and any other filter gets `visibility != locked` ANDed in.
 */
export const applyLockedVisibilityPolicy = (auth: AuthDto, filter: SearchFilter): SearchFilter => {
  if (auth.session?.hasElevatedPermission) {
    return filter;
  }

  if (decidingConditions(filter, 'visibility').some((condition) => canMatch(condition, AssetVisibility.Locked))) {
    requireElevatedPermission(auth);
  }

  if (filter.visibility !== undefined) {
    return filter;
  }

  return { ...filter, visibility: { ne: AssetVisibility.Locked } };
};

/**
 * A filter that asks for private assets is rejected with 401 unless the session is in private mode.
 * Hiding private assets otherwise is left to the search scope, which also keeps partners' private
 * assets out while private mode is on.
 */
export const applyPrivatePolicy = (auth: AuthDto, filter: SearchFilter): SearchFilter => {
  if (isPrivateMode(auth)) {
    return filter;
  }

  const decidingConditions =
    filter.isPrivate === undefined ? (filter.or ?? []).map((branch) => branch.isPrivate) : [filter.isPrivate];
  if (decidingConditions.some((condition) => condition?.eq === true)) {
    requirePrivateMode(auth);
  }

  return filter;
};

export const collectFilterIds = (filter: SearchFilter, field: IdsFilterField): string[] => {
  const ids = new Set<string>();

  for (const branch of filterBranches(filter)) {
    for (const operator of ['any', 'all', 'none'] as const) {
      for (const id of branch[field]?.[operator] ?? []) {
        ids.add(id);
      }
    }
  }

  return [...ids];
};
