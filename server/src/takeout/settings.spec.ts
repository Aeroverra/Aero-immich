import {
  DEFAULT_TAKEOUT_SETTINGS,
  mergeSettings,
  renderTemplate,
  runTags,
  validateSettings,
} from 'src/takeout/settings';
import { TemplateVars } from 'src/takeout/types';
import { describe, expect, it } from 'vitest';

describe('renderTemplate', () => {
  const vars = { date: '2026-09-14', user: '88tontos', email: '88tontos@gmail.com', start: '2026-09-28 14:12:05' };
  it('replaces known placeholders', () => {
    expect(renderTemplate('Source/Google Photos/{date} {user}', vars)).toBe('Source/Google Photos/2026-09-14 88tontos');
    expect(renderTemplate('{user} {email}', vars)).toBe('88tontos 88tontos@gmail.com');
  });
  it('keeps unknown placeholders literally', () => {
    expect(renderTemplate('{immich-go}/{start}', vars)).toBe('{immich-go}/2026-09-28 14:12:05');
  });
  it('tells apart two Google accounts with the same name before the @ by {email}', () => {
    // family: both accounts became "aeroverra" with {user}
    const a = { date: '2026-09-28', user: 'aeroverra', email: 'aeroverra@g.minecraft.technology', start: 'x' };
    const b = { ...a, email: 'aeroverra@minecraft.technology' };
    expect(renderTemplate('{date} {user}', a)).toBe(renderTemplate('{date} {user}', b));
    expect(renderTemplate('{date} {email}', a)).toBe('2026-09-28 aeroverra@g.minecraft.technology');
    expect(renderTemplate('{date} {email}', b)).toBe('2026-09-28 aeroverra@minecraft.technology');
  });
  it('puts the user for {email} of a run created before {email} existed', () => {
    const stored = { date: '2026-09-14', user: '88tontos', start: 'x' } as unknown as TemplateVars;
    expect(renderTemplate('{date} {email}', stored)).toBe('2026-09-14 88tontos');
  });
});

describe('runTags', () => {
  const vars = { date: '2026-09-14', user: '88tontos', email: '88tontos@gmail.com', start: '2026-09-28 14:12:05' };
  it('renders custom tags plus the session tag', () => {
    expect(runTags(DEFAULT_TAKEOUT_SETTINGS, vars)).toEqual([
      'Source/Google Photos/2026-09-14 88tontos@gmail.com',
      '{immich-go}/2026-09-28 14:12:05',
    ]);
  });
  it('omits the session tag when disabled', () => {
    expect(runTags({ ...DEFAULT_TAKEOUT_SETTINGS, sessionTag: false }, { ...vars, start: 'x' })).toEqual([
      'Source/Google Photos/2026-09-14 88tontos@gmail.com',
    ]);
  });
  it('keeps {user} for a custom template that asks for it', () => {
    expect(runTags({ ...DEFAULT_TAKEOUT_SETTINGS, customTags: ['{date} {user}'], sessionTag: false }, vars)).toEqual([
      '2026-09-14 88tontos',
    ]);
  });
});

describe('DEFAULT_TAKEOUT_SETTINGS', () => {
  it('tags each asset with the export date and the whole Google account email', () => {
    expect(DEFAULT_TAKEOUT_SETTINGS.customTags).toEqual(['Source/Google Photos/{date} {email}']);
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
