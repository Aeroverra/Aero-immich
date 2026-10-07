import { DateTime } from 'luxon';
import { inRange, parseDateRange } from 'src/takeout/date-range';
import { describe, expect, it } from 'vitest';

const ZONE = 'America/New_York';

// Ported from immich-go internal/cliFlags daterange_test.go TestDateRange_InRange.
const tables: Array<{ range: string; checks: Array<{ date: string; want: boolean }> }> = [
  {
    range: '2017-08-07,2017-09-07',
    checks: [
      { date: '2017-08-31 17:55:20', want: true },
      { date: '2017-08-07 00:00:00', want: true },
      { date: '2017-09-07 23:59:59', want: true },
      { date: '2017-01-31 07:50:00', want: false },
      { date: '2017-09-08 00:00:00', want: false },
      { date: '2017-12-01 00:00:00', want: false },
    ],
  },
  {
    range: '2017-08-31',
    checks: [
      { date: '2017-08-31 17:55:20', want: true },
      { date: '2017-08-31 00:00:00', want: true },
      { date: '2017-08-31 23:59:59', want: true },
      { date: '2017-01-31 07:50:00', want: false },
      { date: '2017-09-01 00:00:00', want: false },
      { date: '2017-12-01 00:00:00', want: false },
    ],
  },
  {
    range: '2017-08',
    checks: [
      { date: '2017-08-31 17:55:20', want: true },
      { date: '2017-08-01 00:00:00', want: true },
      { date: '2017-08-31 23:59:59', want: true },
      { date: '2017-01-31 07:50:00', want: false },
      { date: '2017-09-01 00:00:00', want: false },
      { date: '2017-12-01 00:00:00', want: false },
    ],
  },
  {
    range: '2017',
    checks: [
      { date: '2017-08-31 17:55:20', want: true },
      { date: '2017-01-01 00:00:00', want: true },
      { date: '2017-12-31 23:59:59', want: true },
      { date: '2016-12-31 23:59:00', want: false },
      { date: '2018-01-01 00:00:00', want: false },
      { date: '2018-12-01 00:00:00', want: false },
    ],
  },
];

// Parses 'YYYY-MM-DD HH:mm:ss' in the same zone the range uses, so bounds compare like Go's time.Local.
function parseCheck(date: string): Date {
  return DateTime.fromFormat(date, 'yyyy-MM-dd HH:mm:ss', { zone: ZONE }).toJSDate();
}

describe('parseDateRange / inRange', () => {
  for (const table of tables) {
    describe(table.range, () => {
      it('round-trips through toString', () => {
        expect(parseDateRange(table.range, ZONE).text).toBe(table.range);
      });
      for (const check of table.checks) {
        it(`${check.date} -> ${check.want}`, () => {
          const range = parseDateRange(table.range, ZONE);
          expect(inRange(range, parseCheck(check.date))).toBe(check.want);
        });
      }
    });
  }

  it('null range imports everything, null date is out of a set range', () => {
    expect(inRange(null, new Date())).toBe(true);
    expect(inRange(parseDateRange('2017', ZONE), null)).toBe(false);
  });

  it('rejects invalid input', () => {
    expect(() => parseDateRange('nope', ZONE)).toThrow();
    expect(() => parseDateRange('2017-13', ZONE)).toThrow();
  });
});
