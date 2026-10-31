import type { AssetMetadataResponseDto } from '@immich/sdk';
import { DateTime } from 'luxon';
import type { Translations } from 'svelte-i18n';

// written by importers such as immich-go for Google Photos takeouts
export const GOOGLE_PHOTOS_KEY = 'google-photos';

// app internal bookkeeping, not meant for people
const hiddenKeys = new Set(['mobile-app', 'deleted-reimport']);

type Translate = (key: Translations, options?: { values: Record<string, string | number> }) => string;

export type CustomFieldRow = { label: string; value: string[] };

export type CustomFieldGroup = { key: string; title: string; rows: CustomFieldRow[] };

const originKeys: Record<string, Translations> = {
  mobileUpload: 'asset_metadata_origin_mobile_upload',
  webUpload: 'asset_metadata_origin_web_upload',
  sharedAlbum: 'asset_metadata_origin_shared_album',
};

const deviceKeys: Record<string, Translations> = {
  ANDROID_PHONE: 'asset_metadata_device_android_phone',
  ANDROID_TABLET: 'asset_metadata_device_android_tablet',
  IOS_PHONE: 'asset_metadata_device_ios_phone',
};

const removedReasonKeys: Record<string, Translations> = {
  NOT_IN_PHOTO: 'asset_metadata_removed_not_in_photo',
  OFF_TOPIC: 'asset_metadata_removed_off_topic',
  NON_HUMAN: 'asset_metadata_removed_non_human',
};

const isPresent = (value: unknown) =>
  value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);

export const formatCustomFieldValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value) && value.every((item) => typeof item !== 'object' || item === null)) {
    return value.map(String).join(', ');
  }
  return JSON.stringify(value);
};

const formatDate = (value: unknown) => {
  const date = typeof value === 'string' ? DateTime.fromISO(value) : undefined;
  return date?.isValid ? date.toLocaleString(DateTime.DATETIME_MED) : formatCustomFieldValue(value);
};

const mapped = (keys: Record<string, Translations>, value: unknown, t: Translate) =>
  typeof value === 'string' && Object.hasOwn(keys, value) ? t(keys[value]) : formatCustomFieldValue(value);

const getGooglePhotosRows = (value: Record<string, unknown>, t: Translate): CustomFieldRow[] => {
  const rows: CustomFieldRow[] = [];
  const add = (field: string, label: Translations, format: (value: unknown) => string | string[]) => {
    if (!isPresent(value[field])) {
      return;
    }
    const formatted = format(value[field]);
    rows.push({ label: t(label), value: Array.isArray(formatted) ? formatted : [formatted] });
  };

  add('takenAt', 'asset_metadata_taken', formatDate);
  add('uploadedAt', 'asset_metadata_uploaded', formatDate);
  add('views', 'asset_metadata_views', formatCustomFieldValue);
  add('origin', 'asset_metadata_origin', (origin) => mapped(originKeys, origin, t));
  add('deviceType', 'asset_metadata_device', (device) => mapped(deviceKeys, device, t));
  add('appPackage', 'asset_metadata_app', formatCustomFieldValue);
  add('deviceFolder', 'asset_metadata_device_folder', formatCustomFieldValue);
  add('altitude', 'asset_metadata_altitude', (altitude) =>
    typeof altitude === 'number'
      ? t('asset_metadata_altitude_value', { values: { altitude: Math.round(altitude * 10) / 10 } })
      : formatCustomFieldValue(altitude),
  );
  add('people', 'asset_metadata_people', formatCustomFieldValue);
  add('peopleRemovedReasons', 'asset_metadata_people_removed', (reasons) =>
    Array.isArray(reasons)
      ? reasons.map((reason) => mapped(removedReasonKeys, reason, t)).join(', ')
      : formatCustomFieldValue(reasons),
  );
  if (value.addedByOtherUser === true) {
    rows.push({ label: t('asset_metadata_added_by_other_user'), value: [t('asset_metadata_yes')] });
  }
  add('comments', 'asset_metadata_comments', (comments) =>
    Array.isArray(comments)
      ? comments.map((comment: { author?: string; text?: string; liked?: boolean }) => {
          const author = comment.author ?? '';
          if (comment.text) {
            return author ? `${author}: ${comment.text}` : comment.text;
          }
          return comment.liked ? t('asset_metadata_comment_liked', { values: { author } }) : author;
        })
      : formatCustomFieldValue(comments),
  );

  return rows;
};

export const getVisibleMetadata = (items: AssetMetadataResponseDto[]) =>
  items.filter(({ key }) => !hiddenKeys.has(key));

export const getCustomFieldGroups = (items: AssetMetadataResponseDto[], t: Translate): CustomFieldGroup[] =>
  getVisibleMetadata(items)
    .map(({ key, value }) => {
      if (key === GOOGLE_PHOTOS_KEY) {
        return { key, title: 'Google Photos', rows: getGooglePhotosRows(value, t) };
      }
      const rows = Object.entries(value)
        .filter(([, fieldValue]) => isPresent(fieldValue))
        .map(([field, fieldValue]) => ({ label: field, value: [formatCustomFieldValue(fieldValue)] }));
      return { key, title: key, rows };
    })
    .filter(({ rows }) => rows.length > 0);

export const getGooglePhotosUrl = (items: AssetMetadataResponseDto[]) => {
  const url = items.find(({ key }) => key === GOOGLE_PHOTOS_KEY)?.value.url;
  return typeof url === 'string' && url.startsWith('https://photos.google.com/') ? url : undefined;
};
