import { formatBookmarkTime, parseBookmarkTime } from '$lib/utils/video-bookmark-time';

describe('formatBookmarkTime', () => {
  it('shows m:ss, h:mm:ss past an hour, and tenths only off the whole second', () => {
    expect(formatBookmarkTime(0)).toBe('0:00');
    expect(formatBookmarkTime(95_000)).toBe('1:35');
    expect(formatBookmarkTime(70_250)).toBe('1:10.3');
    expect(formatBookmarkTime(3_723_000)).toBe('1:02:03');
    expect(formatBookmarkTime(59_960)).toBe('1:00');
    expect(formatBookmarkTime(-5)).toBe('0:00');
  });
});

describe('parseBookmarkTime', () => {
  it('reads seconds, m:ss and h:mm:ss', () => {
    expect(parseBookmarkTime('75')).toBe(75_000);
    expect(parseBookmarkTime('75.5')).toBe(75_500);
    expect(parseBookmarkTime('1:15')).toBe(75_000);
    expect(parseBookmarkTime(' 01:15 ')).toBe(75_000);
    expect(parseBookmarkTime('1:10.3')).toBe(70_300);
    expect(parseBookmarkTime('1:10,25')).toBe(70_250);
    expect(parseBookmarkTime('1:02:03')).toBe(3_723_000);
    expect(parseBookmarkTime('90:00')).toBe(5_400_000);
  });

  it('reads back what it formats', () => {
    for (const ms of [0, 1000, 95_000, 70_300, 3_723_000]) {
      expect(parseBookmarkTime(formatBookmarkTime(ms))).toBe(ms);
    }
  });

  it('refuses text that is not a position', () => {
    for (const text of ['', ' ', 'abc', '1:', ':30', '1:60', '1:61:00', '1:2:3:4', '-5', '1.5:00', '1:ab']) {
      expect(parseBookmarkTime(text)).toBeUndefined();
    }
  });
});
