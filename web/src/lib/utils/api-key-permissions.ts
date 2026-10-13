import { Permission } from '@immich/sdk';

/**
 * Every permission covered by "select all" and by the `all` shortcut. `privateMode.access` is left out on purpose:
 * the server never treats `all` as including it, so it always has to be granted on its own.
 */
export const standardPermissions = Object.values(Permission).filter(
  (permission) => permission !== Permission.All && permission !== Permission.PrivateModeAccess,
);

export const isAllStandardPermissions = (selected: Permission[]) =>
  standardPermissions.every((permission) => selected.includes(permission));

/** Converts the picker selection into what is stored on the key. */
export const toApiKeyPermissions = (selected: Permission[]): Permission[] => {
  if (!isAllStandardPermissions(selected)) {
    return selected;
  }

  return selected.includes(Permission.PrivateModeAccess)
    ? [Permission.All, Permission.PrivateModeAccess]
    : [Permission.All];
};

/** Converts the permissions stored on a key into a picker selection. */
export const fromApiKeyPermissions = (permissions: Permission[]): Permission[] => {
  if (!permissions.includes(Permission.All)) {
    return permissions;
  }

  return permissions.includes(Permission.PrivateModeAccess)
    ? [...standardPermissions, Permission.PrivateModeAccess]
    : [...standardPermissions];
};
