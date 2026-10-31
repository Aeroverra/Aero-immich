import type { AssetTranscriptSegmentResponseDto } from '@immich/sdk';

const pad = (value: number, length = 2) => value.toString().padStart(length, '0');

/** A WebVTT timestamp (hh:mm:ss.ttt) for a position in milliseconds */
export const formatVttTime = (milliseconds: number) => {
  const total = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(total % 1000, 3)}`;
};

/** WebVTT captions with one cue per transcript line */
export const toWebVtt = (segments: AssetTranscriptSegmentResponseDto[]) => {
  const cues = segments.map(({ startTime, endTime, text }, index) => {
    // a cue needs to last a moment to be shown, and its text must not contain the cue separator
    const end = Math.max(endTime, startTime + 500);
    const body = text.replaceAll('-->', '->').replaceAll(/\n{2,}/g, '\n');
    return `${index + 1}\n${formatVttTime(startTime)} --> ${formatVttTime(end)}\n${body}`;
  });
  return ['WEBVTT', ...cues].join('\n\n') + '\n';
};

/** The line being said at the position, else the last line before it, so the transcript always shows where it is */
export const getActiveSegmentIndex = (segments: AssetTranscriptSegmentResponseDto[], position: number) => {
  let active = -1;
  for (const [index, segment] of segments.entries()) {
    if (segment.startTime > position) {
      break;
    }
    active = index;
  }
  return active;
};

/** The lines that contain every word of the query, ignoring case and accents */
export const filterSegments = (segments: AssetTranscriptSegmentResponseDto[], query: string) => {
  const normalize = (text: string) =>
    text
      .normalize('NFD')
      .replaceAll(/\p{Diacritic}/gu, '')
      .toLocaleLowerCase();
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return segments.map((segment, index) => ({ segment, index }));
  }
  return segments.flatMap((segment, index) => {
    const text = normalize(segment.text);
    return words.every((word) => text.includes(word)) ? [{ segment, index }] : [];
  });
};
