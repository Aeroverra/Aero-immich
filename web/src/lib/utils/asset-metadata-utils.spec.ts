import type { Translations } from 'svelte-i18n';
import { getCustomFieldGroups, getGooglePhotosUrl } from '$lib/utils/asset-metadata-utils';

const t = (key: Translations, options?: { values: Record<string, string | number> }) =>
  options ? `${key} ${JSON.stringify(options.values)}` : key;

const item = (key: string, value: object) => ({ key, value, updatedAt: '2026-01-01T00:00:00.000Z' });

describe('getCustomFieldGroups', () => {
  it('formats the Google Photos fields in a fixed order', () => {
    const [group] = getCustomFieldGroups(
      [
        item('google-photos', {
          comments: [
            { author: 'Karen', liked: true },
            { author: 'Sam', text: 'Nice' },
          ],
          views: 158,
          altitude: -15.89,
          deviceType: 'IOS_PHONE',
          addedByOtherUser: true,
          peopleRemovedReasons: ['NOT_IN_PHOTO', 'SOMETHING_NEW'],
          url: 'https://photos.google.com/photo/abc',
          people: [],
        }),
      ],
      t,
    );

    expect(group.title).toBe('Google Photos');
    expect(group.rows).toEqual([
      { label: 'asset_metadata_views', value: ['158'] },
      { label: 'asset_metadata_device', value: ['asset_metadata_device_ios_phone'] },
      { label: 'asset_metadata_altitude', value: ['asset_metadata_altitude_value {"altitude":-15.9}'] },
      { label: 'asset_metadata_people_removed', value: ['asset_metadata_removed_not_in_photo, SOMETHING_NEW'] },
      { label: 'asset_metadata_added_by_other_user', value: ['asset_metadata_yes'] },
      { label: 'asset_metadata_comments', value: ['asset_metadata_comment_liked {"author":"Karen"}', 'Sam: Nice'] },
    ]);
  });

  it('shows unknown keys generically and drops internal or empty ones', () => {
    expect(
      getCustomFieldGroups(
        [
          item('mobile-app', { iCloudId: 'x' }),
          item('empty', { value: null }),
          item('custom', { tags: ['a', 'b'], nested: { a: 1 }, flag: false }),
        ],
        t,
      ),
    ).toEqual([
      {
        key: 'custom',
        title: 'custom',
        rows: [
          { label: 'tags', value: ['a, b'] },
          { label: 'nested', value: ['{"a":1}'] },
          { label: 'flag', value: ['false'] },
        ],
      },
    ]);
  });
});

describe('getGooglePhotosUrl', () => {
  it('only accepts Google Photos links', () => {
    expect(getGooglePhotosUrl([item('google-photos', { url: 'https://photos.google.com/photo/a' })])).toBe(
      'https://photos.google.com/photo/a',
    );
    expect(getGooglePhotosUrl([item('google-photos', { url: 'https://example.com/a' })])).toBeUndefined();
  });
});
