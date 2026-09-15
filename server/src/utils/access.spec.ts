import { Permission } from 'src/enum';
import { isGranted, isPrivateMode, toPrivateScope } from 'src/utils/access';
import { factory } from 'test/small.factory';
import { describe, expect, it } from 'vitest';

describe('isPrivateMode', () => {
  it('should be off without a session or api key', () => {
    expect(isPrivateMode(factory.auth())).toBe(false);
  });

  it('should follow the session flag', () => {
    expect(isPrivateMode(factory.auth({ session: { privateMode: false } }))).toBe(false);
    expect(isPrivateMode(factory.auth({ session: { privateMode: true } }))).toBe(true);
  });

  it('should be on for an api key granted privateMode.access', () => {
    const auth = factory.auth({ apiKey: { permissions: [Permission.AssetRead, Permission.PrivateModeAccess] } });

    expect(isPrivateMode(auth)).toBe(true);
    expect(toPrivateScope(auth)).toEqual({ privateMode: true, userId: auth.user.id });
  });

  it('should not be implied by the all permission', () => {
    const auth = factory.auth({ apiKey: { permissions: [Permission.All] } });

    expect(isPrivateMode(auth)).toBe(false);
    expect(toPrivateScope(auth)).toEqual({ privateMode: false, userId: auth.user.id });
  });

  it('should be on for an api key with all and privateMode.access', () => {
    expect(
      isPrivateMode(factory.auth({ apiKey: { permissions: [Permission.All, Permission.PrivateModeAccess] } })),
    ).toBe(true);
  });
});

describe('isGranted', () => {
  it('should not require privateMode.access for regular permissions', () => {
    expect(
      isGranted({ requested: [Permission.AssetRead], current: [Permission.PrivateModeAccess, Permission.AssetRead] }),
    ).toBe(true);
  });
});
