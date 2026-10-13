import { UserMetadataKey } from 'src/enum';
import { getPreferences } from 'src/utils/preferences';
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
});
