import {
  albumFromJson,
  asMetadata,
  captureDateOf,
  googlePhotosExtra,
  isAlbum,
  isAsset,
  isPartner,
  parseGoogleJson,
  sanitizedTitle,
  withGoogleAccount,
} from 'src/takeout/google-json';
import { GoogleMetadata } from 'src/takeout/types';
import { describe, expect, it } from 'vitest';

function parse(json: string): GoogleMetadata {
  const md = parseGoogleJson(JSON.parse(json));
  if (md === null) {
    throw new Error('parse failed');
  }
  return md;
}

// Ported from json_test.go TestPresentFields (people assertion fixed to [Susan, Justin] per spec).
describe('TestPresentFields', () => {
  const tcs: Array<{
    name: string;
    json: string;
    isPartner?: boolean;
    isAlbum?: boolean;
    isAsset?: boolean;
    isFavorited?: boolean;
    dateTaken?: number;
    title?: string;
    persons?: string[];
  }> = [
    {
      name: 'new_takeout_album_2025',
      json: `{"title": "basement finishing"}`,
      isAlbum: true,
      title: 'basement finishing',
    },
    {
      name: 'regularJSON',
      json: `{"title":"title","description":"","imageViews":"0","creationTime":{"timestamp":"1695397525"},"photoTakenTime":{"timestamp":"1695394176"},"geoData":{"latitude":48.7981917,"longitude":2.4866833,"altitude":90.25},"geoDataExif":{"latitude":48.7981917,"longitude":2.4866833,"altitude":90.25},"favorited":true,"url":"https://x","googlePhotosOrigin":{"mobileUpload":{"deviceFolder":{"localFolderName":""},"deviceType":"ANDROID_PHONE"}}}`,
      isAsset: true,
      isFavorited: true,
      dateTaken: 1_695_394_176,
      title: 'title',
    },
    {
      name: 'old albumJson issue #212',
      json: `{"albumData":{"title":"Trip to Gdańsk","description":"","date":{"timestamp":"1502439626"},"geoData":{"latitude":0,"longitude":0,"altitude":0}}}`,
      isAlbum: true,
      title: 'Trip to Gdańsk',
    },
    {
      name: 'partner',
      json: `{"title":"IMG_1559.HEIC","photoTakenTime":{"timestamp":"1687791968"},"geoData":{"latitude":0,"longitude":0,"altitude":0},"googlePhotosOrigin":{"fromPartnerSharing":{}}}`,
      isPartner: true,
      isAsset: true,
      title: 'IMG_1559.HEIC',
      dateTaken: 1_687_791_968,
    },
    {
      name: 'with People',
      json: `{"title":"IMG_0186.HEIC","photoTakenTime":{"timestamp":"1686305987"},"people":[{"name":"Susan"},{"name":"Justin"}],"googlePhotosOrigin":{"mobileUpload":{"deviceType":"IOS_PHONE"}}}`,
      isAsset: true,
      persons: ['Susan', 'Justin'],
      title: 'IMG_0186.HEIC',
      dateTaken: 1_686_305_987,
    },
    { name: 'bulgarian 1', json: `{"title":"Фокус върху един ден"}`, isAlbum: true, title: 'Фокус върху един ден' },
    { name: 'empty', json: `{}`, title: '' },
    {
      name: 'print_order',
      json: `{"externalOrderId":"417","type":"PURCHASED","quantity":1,"creationTime":{"formatted":"Dec 12"}}`,
    },
  ];

  for (const c of tcs) {
    it(c.name, () => {
      const md = parse(c.json);
      expect(isAsset(md)).toBe(c.isAsset ?? false);
      expect(isAlbum(md)).toBe(c.isAlbum ?? false);
      expect(isPartner(md)).toBe(c.isPartner ?? false);
      expect(md.favorited ?? false).toBe(c.isFavorited ?? false);
      expect(md.title ?? '').toBe(c.title ?? '');
      if (c.dateTaken !== undefined) {
        expect(captureDateOf(md)?.getTime()).toBe(c.dateTaken * 1000);
      }
      if (c.persons !== undefined) {
        expect(asMetadata(md).people).toEqual(c.persons);
      }
    });
  }
});

// Ported from json_test.go TestEnrichedAlbum.
describe('TestEnrichedAlbum', () => {
  it('location enrichment', () => {
    const md = parse(
      `{"title":"Album Title","enrichments":[{"locationEnrichment":{"location":[{"name":"Name_Of_Location (Here I've the city)","description":"Here I've the region","latitudeE7":488029439,"longitudeE7":24854290}]}}]}`,
    );
    const album = albumFromJson(md);
    expect(album.description).toBe("Name_Of_Location (Here I've the city) - Here I've the region");
    expect(album.latitude).toBeCloseTo(48.8029439, 6);
    expect(album.longitude).toBeCloseTo(2.485429, 6);
  });

  it('narrative and location enrichments', () => {
    const md = parse(
      `{"title":"Album test","date":{"timestamp":"1697872351"},"enrichments":[{"narrativeEnrichment":{"text":"Ici c'est du text"}},{"narrativeEnrichment":{"text":"Et hop"}},{"locationEnrichment":{"location":[{"name":"Saint-Maur-des-Fossés","description":"Île-de-France","latitudeE7":488029439,"longitudeE7":24854290}]}},{"locationEnrichment":{"location":[{"name":"Champigny-sur-Marne","description":"Île-de-France","latitudeE7":488236547,"longitudeE7":24964847}]}}]}`,
    );
    const album = albumFromJson(md);
    expect(album.description).toBe(
      "Ici c'est du text\nEt hop\nSaint-Maur-des-Fossés - Île-de-France\nChampigny-sur-Marne - Île-de-France",
    );
    expect(album.latitude).toBeCloseTo(48.8236547, 6);
    expect(album.longitude).toBeCloseTo(2.4964847, 6);
  });
});

// Ported from json_test.go TestSanitizedTitle.
describe('TestSanitizedTitle', () => {
  const cases: Array<[string, string]> = [
    ['HelloWorld', 'HelloWorld'],
    ['Hello:World', 'Hello_World'],
    ['Hello\nWorld', 'Hello_World'],
    ['Some/File|Name?', 'Some_File_Name_'],
    [String.raw`123123\.JPG`, '123123_.JPG'],
  ];
  for (const [input, expected] of cases) {
    it(input, () => expect(sanitizedTitle(input)).toBe(expected));
  }
});

// Ported from json_extra_test.go TestGoogleMetadataExtra.
describe('TestGoogleMetadataExtra', () => {
  it('full sidecar', () => {
    const md = parse(
      `{"title":"PXL_20240101_120000000.jpg","imageViews":"12","creationTime":{"timestamp":"1704200000"},"photoTakenTime":{"timestamp":"1704110400"},"geoData":{"latitude":1.5,"longitude":2.5,"altitude":30.5},"geoDataExif":{"latitude":0,"longitude":0,"altitude":0},"people":[{"name":"Alice"},{"name":"Bob"}],"url":"https://photos.google.com/photo/abc","googlePhotosOrigin":{"fromSharedAlbum":{}},"appSource":{"androidPackageName":"com.whatsapp"},"composition":{"type":"AUTO"},"removeResultReason":[{"reason":["NOT_IN_PHOTO"]},{"reason":["OFF_TOPIC"]}],"sharedAlbumComments":[{"creationTime":{"timestamp":"1704300000"},"contentOwnerName":"Carol","text":"nice"},{"contentOwnerName":"Dan","liked":true}]}`,
    );
    expect(googlePhotosExtra(md)).toEqual({
      url: 'https://photos.google.com/photo/abc',
      uploadedAt: '2024-01-02T12:53:20Z',
      takenAt: '2024-01-01T12:00:00Z',
      views: 12,
      altitude: 30.5,
      origin: 'sharedAlbum',
      addedByOtherUser: true,
      appPackage: 'com.whatsapp',
      composition: 'AUTO',
      people: ['Alice', 'Bob'],
      peopleRemovedReasons: ['NOT_IN_PHOTO', 'OFF_TOPIC'],
      comments: [
        { author: 'Carol', text: 'nice', at: '2024-01-03T16:40:00Z' },
        { author: 'Dan', liked: true },
      ],
    });
  });

  it('mobile origin', () => {
    const md = parse(
      `{"title":"a.jpg","photoTakenTime":{"timestamp":"1"},"googlePhotosOrigin":{"mobileUpload":{"deviceType":"ANDROID_PHONE","deviceFolder":{"localFolderName":"Screenshots"}}}}`,
    );
    const e = googlePhotosExtra(md);
    expect(e.origin).toBe('mobileUpload');
    expect(e.deviceType).toBe('ANDROID_PHONE');
    expect(e.deviceFolder).toBe('Screenshots');
  });
});

describe('withGoogleAccount', () => {
  const extra = { url: 'https://photos.google.com/photo/AF1Qip', views: 1 };

  it('stores the account email next to the url it produced', () => {
    expect(withGoogleAccount(extra, { email: 'aeroverra@g.minecraft.technology' })).toEqual({
      ...extra,
      account: 'aeroverra@g.minecraft.technology',
    });
  });

  it('stores no account for a run without an email', () => {
    expect(withGoogleAccount(extra, { email: 'Nicholas Halka' })).toBe(extra);
    expect(withGoogleAccount(extra, {} as any)).toBe(extra);
    expect(withGoogleAccount(extra, null)).toBe(extra);
  });

  it('stores no account without a url', () => {
    expect(withGoogleAccount({ views: 1 }, { email: 'a@b.c' })).toEqual({ views: 1 });
  });
});
