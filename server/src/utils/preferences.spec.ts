import { LockTrigger, StackActionMode, UserMetadataKey } from 'src/enum';
import { getPreferences, getPreferencesPartial } from 'src/utils/preferences';
import { describe, expect, it } from 'vitest';

describe('preferences', () => {
  describe('privateMode', () => {
    it('should default to a 30 minute timeout, the sidebar link, no private memories and locking on app pause', () => {
      expect(getPreferences([]).privateMode).toEqual({
        timeoutMinutes: 30,
        sidebarWeb: true,
        includeInMemories: false,
        lockTrigger: LockTrigger.AppPause,
      });
    });

    it('should merge stored private mode preferences over the defaults', () => {
      const preferences = getPreferences([
        { key: UserMetadataKey.Preferences, value: { privateMode: { includeInMemories: true } } },
      ]);

      expect(preferences.privateMode).toEqual({
        timeoutMinutes: 30,
        sidebarWeb: true,
        includeInMemories: true,
        lockTrigger: LockTrigger.AppPause,
      });
    });

    it('should only store a lock trigger that differs from the default', () => {
      const preferences = getPreferences([]);
      expect(getPreferencesPartial(preferences)).toEqual({});

      preferences.privateMode.lockTrigger = LockTrigger.Timeout;
      expect(getPreferencesPartial(preferences)).toEqual({ privateMode: { lockTrigger: LockTrigger.Timeout } });
    });
  });

  describe('customViews', () => {
    it('should default to locking when the screen turns off', () => {
      expect(getPreferences([]).customViews).toEqual({ lockTrigger: LockTrigger.ScreenOff });
    });

    it('should merge a stored lock trigger over the default', () => {
      const preferences = getPreferences([
        { key: UserMetadataKey.Preferences, value: { customViews: { lockTrigger: LockTrigger.Timeout } } },
      ]);

      expect(preferences.customViews).toEqual({ lockTrigger: LockTrigger.Timeout });
    });

    it('should only store a lock trigger that differs from the default', () => {
      const preferences = getPreferences([]);
      expect(getPreferencesPartial(preferences)).toEqual({});

      preferences.customViews.lockTrigger = LockTrigger.AppPause;
      expect(getPreferencesPartial(preferences)).toEqual({ customViews: { lockTrigger: LockTrigger.AppPause } });
    });
  });

  describe('stackActions', () => {
    it('should ask by default', () => {
      expect(getPreferences([]).stackActions).toEqual({ mode: StackActionMode.Ask });
    });

    it('should merge a remembered choice over the default', () => {
      const preferences = getPreferences([
        { key: UserMetadataKey.Preferences, value: { stackActions: { mode: StackActionMode.Stack } } },
      ]);

      expect(preferences.stackActions).toEqual({ mode: StackActionMode.Stack });
    });

    it('should only store a choice that differs from the default', () => {
      const preferences = getPreferences([]);
      expect(getPreferencesPartial(preferences)).toEqual({});

      preferences.stackActions.mode = StackActionMode.Primary;
      expect(getPreferencesPartial(preferences)).toEqual({ stackActions: { mode: StackActionMode.Primary } });
    });
  });
});
