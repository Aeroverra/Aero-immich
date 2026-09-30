import {
  DEFAULT_TAKEOUT_SETTINGS,
  mergeSettings,
  renderTemplate,
  runTags,
  validateSettings,
} from 'src/takeout/settings';
import { describe, expect, it } from 'vitest';

describe('renderTemplate', () => {
  const vars = { date: '2026-09-14', user: '88tontos', start: '2026-09-28 14:12:05' };
  it('replaces known placeholders', () => {
    expect(renderTemplate('Source/Google Photos/{date} {user}', vars)).toBe('Source/Google Photos/2026-09-14 88tontos');
  });
  it('keeps unknown placeholders literally', () => {
    expect(renderTemplate('{immich-go}/{start}', vars)).toBe('{immich-go}/2026-09-28 14:12:05');
  });
});

describe('runTags', () => {
  it('renders custom tags plus the session tag', () => {
    const vars = { date: '2026-09-14', user: '88tontos', start: '2026-09-28 14:12:05' };
    expect(runTags(DEFAULT_TAKEOUT_SETTINGS, vars)).toEqual([
      'Source/Google Photos/2026-09-14 88tontos',
      '{immich-go}/2026-09-28 14:12:05',
    ]);
  });
  it('omits the session tag when disabled', () => {
    const vars = { date: '2026-09-14', user: '88tontos', start: 'x' };
    expect(runTags({ ...DEFAULT_TAKEOUT_SETTINGS, sessionTag: false }, vars)).toEqual([
      'Source/Google Photos/2026-09-14 88tontos',
    ]);
  });
});

describe('mergeSettings', () => {
  it('returns defaults for null', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_TAKEOUT_SETTINGS);
  });
  it('overlays a partial', () => {
    expect(mergeSettings({ burst: 'NoStack', homeTimeZone: 'Europe/Paris' })).toMatchObject({
      burst: 'NoStack',
      homeTimeZone: 'Europe/Paris',
      rawJpg: 'StackCoverRaw',
    });
  });
});

describe('validateSettings', () => {
  it('accepts valid settings', () => {
    expect(validateSettings(DEFAULT_TAKEOUT_SETTINGS)).toEqual([]);
  });
  it('rejects a bad zone, enum, negative count, bad range and empty tag', () => {
    const errors = validateSettings({
      homeTimeZone: 'Mars/Phobos',
      burst: 'Nope' as never,
      stopAfterErrors: -1,
      dateRange: 'not-a-date',
      customTags: ['  '],
    });
    expect(errors.length).toBe(5);
  });
});
