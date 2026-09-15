import { StackActionMode, UserMetadataKey } from 'src/enum';
import { getPreferences, getPreferencesPartial } from 'src/utils/preferences';
import { describe, expect, it } from 'vitest';

describe('preferences', () => {
  describe('privateMode', () => {
    it('should default to a 30 minute timeout, the sidebar link and no private memories', () => {
      expect(getPreferences([]).privateMode).toEqual({
        timeoutMinutes: 30,
        sidebarWeb: true,
        includeInMemories: false,
      });
    });

    it('should merge stored private mode preferences over the defaults', () => {
      const preferences = getPreferences([
        { key: UserMetadataKey.Preferences, value: { privateMode: { includeInMemories: true } } },
      ]);

      expect(preferences.privateMode).toEqual({ timeoutMinutes: 30, sidebarWeb: true, includeInMemories: true });
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
