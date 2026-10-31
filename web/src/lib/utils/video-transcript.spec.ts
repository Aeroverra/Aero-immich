import { filterSegments, formatVttTime, getActiveSegmentIndex, toWebVtt } from '$lib/utils/video-transcript';

const segments = [
  { startTime: 110, endTime: 4490, text: "I'm going to do the best I can because I'm driving." },
  { startTime: 6790, endTime: 14_850, text: 'But I just went to the last full moon party at St. Thomas.' },
  { startTime: 3_725_000, endTime: 3_725_000, text: 'Café --> later' },
];

describe('formatVttTime', () => {
  it('should format hours, minutes, seconds and milliseconds', () => {
    expect(formatVttTime(0)).toBe('00:00:00.000');
    expect(formatVttTime(6790)).toBe('00:00:06.790');
    expect(formatVttTime(3_725_042)).toBe('01:02:05.042');
    expect(formatVttTime(-5)).toBe('00:00:00.000');
  });
});

describe('toWebVtt', () => {
  it('should make one cue per line', () => {
    expect(toWebVtt(segments)).toBe(
      [
        'WEBVTT',
        "1\n00:00:00.110 --> 00:00:04.490\nI'm going to do the best I can because I'm driving.",
        '2\n00:00:06.790 --> 00:00:14.850\nBut I just went to the last full moon party at St. Thomas.',
        '3\n01:02:05.000 --> 01:02:05.500\nCafé -> later',
      ].join('\n\n') + '\n',
    );
  });

  it('should be a valid empty file without lines', () => {
    expect(toWebVtt([])).toBe('WEBVTT\n');
  });
});

describe('getActiveSegmentIndex', () => {
  it('should find the line being said, or the last one before the position', () => {
    expect(getActiveSegmentIndex(segments, 0)).toBe(-1);
    expect(getActiveSegmentIndex(segments, 110)).toBe(0);
    expect(getActiveSegmentIndex(segments, 5000)).toBe(0);
    expect(getActiveSegmentIndex(segments, 7000)).toBe(1);
    expect(getActiveSegmentIndex(segments, 10_000_000)).toBe(2);
    expect(getActiveSegmentIndex([], 1000)).toBe(-1);
  });
});

describe('filterSegments', () => {
  it('should keep every line without a query', () => {
    expect(filterSegments(segments, '  ').map(({ index }) => index)).toEqual([0, 1, 2]);
  });

  it('should match every word, ignoring case and accents', () => {
    expect(filterSegments(segments, 'MOON party').map(({ index }) => index)).toEqual([1]);
    expect(filterSegments(segments, 'cafe').map(({ index }) => index)).toEqual([2]);
    expect(filterSegments(segments, 'moon driving')).toEqual([]);
  });
});
