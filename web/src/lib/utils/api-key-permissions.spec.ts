import { Permission } from '@immich/sdk';
import {
  fromApiKeyPermissions,
  isAllStandardPermissions,
  standardPermissions,
  toApiKeyPermissions,
} from '$lib/utils/api-key-permissions';

describe('api key permissions', () => {
  it('should leave all and privateMode.access out of the standard permissions', () => {
    expect(standardPermissions).not.toContain(Permission.All);
    expect(standardPermissions).not.toContain(Permission.PrivateModeAccess);
    expect(standardPermissions).toContain(Permission.AssetRead);
  });

  it('should collapse a full selection into all', () => {
    expect(isAllStandardPermissions(standardPermissions)).toBe(true);
    expect(toApiKeyPermissions([...standardPermissions])).toEqual([Permission.All]);
  });

  it('should keep privateMode.access next to all', () => {
    expect(toApiKeyPermissions([...standardPermissions, Permission.PrivateModeAccess])).toEqual([
      Permission.All,
      Permission.PrivateModeAccess,
    ]);
  });

  it('should keep a partial selection as is', () => {
    const selected = [Permission.AssetRead, Permission.PrivateModeAccess];
    expect(toApiKeyPermissions(selected)).toEqual(selected);
  });

  it('should expand all back into a selection without privateMode.access', () => {
    expect(fromApiKeyPermissions([Permission.All])).toEqual(standardPermissions);
    expect(fromApiKeyPermissions([Permission.All, Permission.PrivateModeAccess])).toEqual([
      ...standardPermissions,
      Permission.PrivateModeAccess,
    ]);
    expect(fromApiKeyPermissions([Permission.AssetRead])).toEqual([Permission.AssetRead]);
  });
});
