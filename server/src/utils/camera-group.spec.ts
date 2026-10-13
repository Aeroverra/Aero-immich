import {
  CameraGroupKind,
  getCameraGroupFile,
  getCameraGroupTagChanges,
  matchesTagPattern,
  orderCameraGroup,
} from 'src/utils/camera-group';
import { describe, expect, it } from 'vitest';

const member = (id: string, originalFileName: string) => ({
  id,
  originalFileName,
  file: getCameraGroupFile(originalFileName)!,
});

describe('getCameraGroupFile', () => {
  it.each([
    ['PXL_20250929_175225242.VB-02.MAIN.mp4', 'PXL_20250929_175225242.VB', CameraGroupKind.VideoPair, true],
    ['PXL_20250929_175225242.VB-01.COVER.mp4', 'PXL_20250929_175225242.VB', CameraGroupKind.VideoPair, false],
    ['PXL_20250126_083154439.NS-02.MAIN.mp4', 'PXL_20250126_083154439.NS', CameraGroupKind.VideoPair, true],
    ['PXL_20240411_181110948.LONG_EXPOSURE-01.COVER.jpg', 'PXL_20240411_181110948', CameraGroupKind.PhotoSet, true],
    ['PXL_20240411_181110948.LONG_EXPOSURE-02.ORIGINAL.jpg', 'PXL_20240411_181110948', CameraGroupKind.PhotoSet, false],
    ['PXL_20230101_120000000.RAW-01.MP.COVER.jpg', 'PXL_20230101_120000000', CameraGroupKind.PhotoSet, true],
    ['PXL_20230101_120000000.RAW-02.ORIGINAL.dng', 'PXL_20230101_120000000', CameraGroupKind.PhotoSet, false],
    ['PXL_20210101_120000000.PORTRAIT-01.COVER.jpg', 'PXL_20210101_120000000', CameraGroupKind.PhotoSet, true],
    ['00000IMG_00000_BURST20190530194629_COVER.jpg', 'BURST20190530194629', CameraGroupKind.Burst, true],
    ['00001IMG_00001_BURST20190530194629.jpg', 'BURST20190530194629', CameraGroupKind.Burst, false],
    ['00100lrPORTRAIT_00100_BURST20200310135445734_COVER.jpg', 'BURST20200310135445734', CameraGroupKind.Burst, true],
  ])('recognizes %s', (name, key, kind, isPrimary) => {
    expect(getCameraGroupFile(name)).toMatchObject({ key, kind, isPrimary });
  });

  it.each([
    'PXL_20250929_175225242.mp4',
    'PXL_20250929_175225242.MP.jpg',
    'PXL_20250929_175225242.VB-01.COVER~2.mp4',
    'PXL_20250929_175225242.VB-01.COVER(1).mp4',
    'PXL_20240411_181110948.LONG_EXPOSURE-01.COVER-edited.jpg',
    '00000IMG_00000_BURST20190530194629_COVER-edited.jpg',
    '00000IMG_00000_BURST20190530194629_COVER~2.jpg',
    'IMG_1234.JPG',
  ])('leaves %s alone', (name) => {
    expect(getCameraGroupFile(name)).toBeNull();
  });

  it('gives a pattern that matches every file of the shot', () => {
    expect(getCameraGroupFile('PXL_20250929_175225242.VB-01.COVER.mp4')?.pattern).toBe('PXL_20250929_175225242.VB-%');
    expect(getCameraGroupFile('00001IMG_00001_BURST20190530194629.jpg')?.pattern).toBe('%BURST20190530194629%');
  });
});

const isVideo = ({ originalFileName }: { originalFileName: string }) => originalFileName.endsWith('.mp4');
const tag = (id: string) => ({ id, value: id });

describe('orderCameraGroup', () => {
  it('puts the MAIN video of a pair on top', () => {
    const cover = member('cover', 'PXL_20250929_175225242.VB-01.COVER.mp4');
    const main = member('main', 'PXL_20250929_175225242.VB-02.MAIN.mp4');
    expect(orderCameraGroup(CameraGroupKind.VideoPair, [cover, main], isVideo)?.map(({ id }) => id)).toEqual([
      'main',
      'cover',
    ]);
  });

  it('puts the COVER of a photo set on top', () => {
    const original = member('original', 'PXL_20240411_181110948.LONG_EXPOSURE-02.ORIGINAL.jpg');
    const cover = member('cover', 'PXL_20240411_181110948.LONG_EXPOSURE-01.COVER.jpg');
    expect(orderCameraGroup(CameraGroupKind.PhotoSet, [original, cover], isVideo)?.map(({ id }) => id)).toEqual([
      'cover',
      'original',
    ]);
  });

  it('puts the cover frame of a burst on top and the others in frame order', () => {
    const frames = [
      member('2', '00002IMG_00002_BURST20190530194629.jpg'),
      member('cover', '00000IMG_00000_BURST20190530194629_COVER.jpg'),
      member('1', '00001IMG_00001_BURST20190530194629.jpg'),
    ];
    expect(orderCameraGroup(CameraGroupKind.Burst, frames, isVideo)?.map(({ id }) => id)).toEqual(['cover', '1', '2']);
  });

  it('orders a burst without a cover frame by frame number', () => {
    const frames = [
      member('2', '00002IMG_00002_BURST20190530194629.jpg'),
      member('1', '00001IMG_00001_BURST20190530194629.jpg'),
    ];
    expect(orderCameraGroup(CameraGroupKind.Burst, frames, isVideo)?.map(({ id }) => id)).toEqual(['1', '2']);
  });

  it('needs more than one file', () => {
    expect(
      orderCameraGroup(CameraGroupKind.VideoPair, [member('main', 'PXL_20250929_175225242.VB-02.MAIN.mp4')], isVideo),
    ).toBeNull();
  });

  it('leaves a pair alone when a file is there twice', () => {
    const members = [
      member('cover', 'PXL_20250929_175225242.VB-01.COVER.mp4'),
      member('main', 'PXL_20250929_175225242.VB-02.MAIN.mp4'),
      member('main-again', 'PXL_20250929_175225242.VB-02.MAIN.mp4'),
    ];
    expect(orderCameraGroup(CameraGroupKind.VideoPair, members, isVideo)).toBeNull();
  });

  it('leaves a pair of two covers alone', () => {
    const members = [
      member('cover', 'PXL_20250929_175225242.VB-01.COVER.mp4'),
      member('cover-2', 'PXL_20250929_175225242.VB-03.COVER.mp4'),
    ];
    expect(orderCameraGroup(CameraGroupKind.VideoPair, members, isVideo)).toBeNull();
  });

  it('leaves a photo set without a cover alone', () => {
    const members = [
      member('a', 'PXL_20240411_181110948.LONG_EXPOSURE-02.ORIGINAL.jpg'),
      member('b', 'PXL_20240411_181110948.RAW-02.ORIGINAL.dng'),
    ];
    expect(orderCameraGroup(CameraGroupKind.PhotoSet, members, isVideo)).toBeNull();
  });

  it('leaves a burst with two cover frames alone', () => {
    const members = [
      member('a', '00000IMG_00000_BURST20190530194629_COVER.jpg'),
      member('b', '00001IMG_00001_BURST20190530194629_COVER.jpg'),
    ];
    expect(orderCameraGroup(CameraGroupKind.Burst, members, isVideo)).toBeNull();
  });
});

describe('matchesTagPattern', () => {
  it('matches whole values, with * for anything', () => {
    expect(matchesTagPattern('Source/Google Photos/2026-09-07 88tontos', ['Source/*'])).toBe(true);
    expect(matchesTagPattern('{immich-go}/2025-11-26 10:00', ['{immich-go}/*'])).toBe(true);
    expect(matchesTagPattern('Takeout', ['Takeout'])).toBe(true);
    expect(matchesTagPattern('takeout-2026-09-29', ['takeout-*'])).toBe(true);
    expect(matchesTagPattern('Takeout/Albums', ['Takeout'])).toBe(false);
    expect(matchesTagPattern('People/Source', ['Source/*'])).toBe(false);
    expect(matchesTagPattern('Anything', ['', '  '])).toBe(false);
  });

  it('treats other characters literally', () => {
    expect(matchesTagPattern('a.b', ['a.b'])).toBe(true);
    expect(matchesTagPattern('axb', ['a.b'])).toBe(false);
  });
});

describe('getCameraGroupTagChanges', () => {
  const rules = { keep: ['{immich-go}/*', 'Source/*', 'Takeout', 'takeout-*'], review: ['Unreviewed'] };

  it('copies a tag to the files that miss it', () => {
    const changes = getCameraGroupTagChanges(
      [
        { assetId: 'cover', tags: [tag('People/Mom'), tag('Found by video analysis')] },
        { assetId: 'main', tags: [] },
      ],
      rules,
    );
    expect(changes.add).toEqual([
      { assetId: 'main', tagId: 'People/Mom' },
      { assetId: 'main', tagId: 'Found by video analysis' },
    ]);
    expect(changes.remove).toEqual([]);
  });

  it('keeps where a file came from on that file', () => {
    const changes = getCameraGroupTagChanges(
      [
        { assetId: 'cover', tags: [tag('Source/Google Photos/2026-09-07'), tag('Takeout'), tag('takeout-1')] },
        { assetId: 'main', tags: [tag('{immich-go}/2025-11-26')] },
      ],
      rules,
    );
    expect(changes).toEqual({ add: [], remove: [] });
  });

  it('marks the whole shot reviewed when one file is reviewed', () => {
    const changes = getCameraGroupTagChanges(
      [
        { assetId: 'cover', tags: [] },
        { assetId: 'main', tags: [tag('Unreviewed')] },
      ],
      rules,
    );
    expect(changes).toEqual({ add: [], remove: [{ assetId: 'main', tagId: 'Unreviewed' }] });
  });

  it('keeps a review tag every file has', () => {
    const changes = getCameraGroupTagChanges(
      [
        { assetId: 'cover', tags: [tag('Unreviewed')] },
        { assetId: 'main', tags: [tag('Unreviewed')] },
      ],
      rules,
    );
    expect(changes).toEqual({ add: [], remove: [] });
  });
});
