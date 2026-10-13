import { DateTime } from 'luxon';
import { DateRange } from 'src/takeout/types';

// Port of immich-go internal/cliFlags DateRange (Set/InRange/String). Bounds are evaluated in the given zone.
export function parseDateRange(text: string, zone: string): DateRange {
  const fail = (): never => {
    throw new Error(`invalid date range:${text}`);
  };
  let after: DateTime;
  let before: DateTime;
  switch (text.length) {
    case 4: {
      after = DateTime.fromFormat(text, 'yyyy', { zone });
      if (!after.isValid) {
        fail();
      }
      before = after.plus({ years: 1 });
      break;
    }
    case 7: {
      after = DateTime.fromFormat(text, 'yyyy-MM', { zone });
      if (!after.isValid) {
        fail();
      }
      before = after.plus({ months: 1 });
      break;
    }
    case 10: {
      after = DateTime.fromFormat(text, 'yyyy-MM-dd', { zone });
      if (!after.isValid) {
        fail();
      }
      before = after.plus({ days: 1 });
      break;
    }
    case 21: {
      after = DateTime.fromFormat(text.slice(0, 10), 'yyyy-MM-dd', { zone });
      const end = DateTime.fromFormat(text.slice(11), 'yyyy-MM-dd', { zone });
      if (!after.isValid || !end.isValid || text[10] !== ',') {
        fail();
      }
      before = end.plus({ days: 1 });
      break;
    }
    default: {
      return fail();
    }
  }
  if (before < after) {
    fail();
  }
  return {
    after: after.toJSDate(),
    before: before.toJSDate(),
    text: dateRangeToString(after.toJSDate(), before.toJSDate(), zone),
  };
}

// Go DateRange.String(): reconstructs the shortest form from the bounds.
export function dateRangeToString(after: Date, before: Date, zone: string): string {
  const a = DateTime.fromJSDate(after, { zone });
  const b = DateTime.fromJSDate(before, { zone });
  if (a.month === 1 && a.day === 1 && +b === +a.plus({ years: 1 })) {
    return a.toFormat('yyyy');
  }
  if (a.day === 1 && +b === +a.plus({ months: 1 })) {
    return a.toFormat('yyyy-MM');
  }
  if (+b === +a.plus({ days: 1 })) {
    return a.toFormat('yyyy-MM-dd');
  }
  return `${a.toFormat('yyyy-MM-dd')},${b.minus({ days: 1 }).toFormat('yyyy-MM-dd')}`;
}

// Go DateRange.InRange: After <= d < Before. A null range imports everything; a null date (Go zero time) is out.
export function inRange(range: DateRange | null, date: Date | null): boolean {
  if (range === null) {
    return true;
  }
  if (date === null) {
    return false;
  }
  return date.getTime() >= range.after.getTime() && range.before.getTime() > date.getTime();
}
