import { IANAZone } from 'luxon';
import { parseDateRange } from 'src/takeout/date-range';
import { BURST_MODES, HEIC_JPG_MODES, RAW_JPG_MODES, VIDEO_BOOST_MODES } from 'src/takeout/filters';
import { TakeoutSettings, TemplateVars } from 'src/takeout/types';

export const DEFAULT_TAKEOUT_SETTINGS: Readonly<TakeoutSettings> = Object.freeze({
  rawJpg: 'StackCoverRaw',
  burst: 'Stack',
  heicJpg: 'NoStack',
  videoBoost: 'Stack',
  customTags: ['Source/Google Photos/{date} {user}'],
  sessionTag: true,
  sessionTagTemplate: '{immich-go}/{start}',
  takeoutTag: true,
  peopleTags: true,
  onErrors: 'continue',
  stopAfterErrors: 0,
  dateRange: null,
  syncAlbums: true,
  includePartner: true,
  includeArchived: true,
  includeTrashed: false,
  includeUnmatched: false,
  googlePhotosFields: true,
  applyRotation: true,
  tagServerDuplicates: false,
  burstByTime: false,
  homeTimeZone: 'America/New_York',
});

const KEYS = Object.keys(DEFAULT_TAKEOUT_SETTINGS) as Array<keyof TakeoutSettings>;

// Merges a stored partial over the defaults; unknown keys are ignored.
export function mergeSettings(saved: Partial<TakeoutSettings> | null): TakeoutSettings {
  const result = { ...DEFAULT_TAKEOUT_SETTINGS } as TakeoutSettings;
  if (saved) {
    for (const key of KEYS) {
      if (saved[key] !== undefined && saved[key] !== null) {
        (result as unknown as Record<string, unknown>)[key] = saved[key];
      } else if (key === 'dateRange' && saved.dateRange === null) {
        result.dateRange = null;
      }
    }
  }
  return result;
}

export function validateSettings(value: Partial<TakeoutSettings>): string[] {
  const errors: string[] = [];
  const checkEnum = (key: keyof TakeoutSettings, values: readonly string[]) => {
    const v = value[key];
    if (v !== undefined && !values.includes(v as string)) {
      errors.push(`${key} must be one of ${values.join(', ')}`);
    }
  };
  checkEnum('rawJpg', RAW_JPG_MODES);
  checkEnum('burst', BURST_MODES);
  checkEnum('heicJpg', HEIC_JPG_MODES);
  checkEnum('videoBoost', VIDEO_BOOST_MODES);
  checkEnum('onErrors', ['continue', 'stop']);

  if (
    value.stopAfterErrors !== undefined &&
    (!Number.isSafeInteger(value.stopAfterErrors) || value.stopAfterErrors < 0)
  ) {
    errors.push('stopAfterErrors must be a non-negative integer');
  }
  if (value.homeTimeZone !== undefined && !IANAZone.isValidZone(value.homeTimeZone)) {
    errors.push(`homeTimeZone is not a valid IANA time zone: ${value.homeTimeZone}`);
  }
  if (value.dateRange !== undefined && value.dateRange !== null) {
    try {
      parseDateRange(value.dateRange, value.homeTimeZone ?? DEFAULT_TAKEOUT_SETTINGS.homeTimeZone);
    } catch {
      errors.push(`dateRange is invalid: ${value.dateRange}`);
    }
  }
  if (value.customTags !== undefined) {
    for (const tag of value.customTags) {
      if (typeof tag !== 'string' || tag.trim() === '') {
        errors.push('custom tags must be non-empty');
        break;
      }
    }
  }
  return errors;
}

// Replaces the known placeholders; every other {...} is kept literally (0.4).
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template
    .replaceAll('{date}', () => vars.date)
    .replaceAll('{user}', () => vars.user)
    .replaceAll('{start}', () => vars.start);
}

// Custom tags plus the session tag (when enabled), all template-rendered.
export function runTags(settings: TakeoutSettings, vars: TemplateVars): string[] {
  const tags = settings.customTags.map((tag) => renderTemplate(tag, vars));
  if (settings.sessionTag) {
    tags.push(renderTemplate(settings.sessionTagTemplate, vars));
  }
  return tags;
}
