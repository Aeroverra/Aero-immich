/**
 * A bookmark position (milliseconds) as the text shown in the time field: m:ss or h:mm:ss, with tenths only when the
 * position is not on a whole second, so a bookmark set while playing still reads back exactly enough to edit.
 */
export const formatBookmarkTime = (ms: number) => {
  const tenths = Math.round(Math.max(0, ms) / 100);
  const totalSeconds = Math.floor(tenths / 10);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const fraction = tenths % 10 === 0 ? '' : `.${tenths % 10}`;
  const ss = `${String(seconds).padStart(2, '0')}${fraction}`;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
};

/**
 * Reads a typed position: seconds ("75", "75.5"), m:ss ("1:15") or h:mm:ss ("1:02:03"), a comma works as the decimal
 * point. Returns milliseconds, or undefined when the text is not a position.
 */
export const parseBookmarkTime = (text: string): number | undefined => {
  const parts = text.trim().replace(',', '.').split(':');
  if (parts.length > 3 || parts.includes('')) {
    return;
  }

  const seconds = parts.at(-1)!;
  const whole = parts.slice(0, -1);
  if (!/^\d+(\.\d+)?$/.test(seconds) || whole.some((part) => !/^\d+$/.test(part))) {
    return;
  }

  const [hours, minutes] = whole.length === 2 ? whole.map(Number) : [0, Number(whole[0] ?? 0)];
  const secondsValue = Number(seconds);
  // below the largest unit, a field wraps at 60 like a clock
  if ((whole.length > 0 && secondsValue >= 60) || (whole.length === 2 && minutes >= 60)) {
    return;
  }

  return Math.round(((hours * 60 + minutes) * 60 + secondsValue) * 1000);
};
