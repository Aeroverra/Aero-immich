import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/utils/video_bookmark_time.dart';

void main() {
  test('formats m:ss, h:mm:ss past an hour, tenths only off the whole second', () {
    expect(formatBookmarkTime(0), '0:00');
    expect(formatBookmarkTime(95000), '1:35');
    expect(formatBookmarkTime(70250), '1:10.3');
    expect(formatBookmarkTime(3723000), '1:02:03');
    expect(formatBookmarkTime(59960), '1:00');
    expect(formatBookmarkTime(-5), '0:00');
  });

  test('reads seconds, m:ss and h:mm:ss', () {
    expect(parseBookmarkTime('75'), 75000);
    expect(parseBookmarkTime('75.5'), 75500);
    expect(parseBookmarkTime('1:15'), 75000);
    expect(parseBookmarkTime(' 01:15 '), 75000);
    expect(parseBookmarkTime('1:10,25'), 70250);
    expect(parseBookmarkTime('1:02:03'), 3723000);
    expect(parseBookmarkTime('90:00'), 5400000);
  });

  test('reads back what it formats', () {
    for (final ms in [0, 1000, 95000, 70300, 3723000]) {
      expect(parseBookmarkTime(formatBookmarkTime(ms)), ms);
    }
  });

  test('refuses text that is not a position', () {
    for (final text in ['', ' ', 'abc', '1:', ':30', '1:60', '1:61:00', '1:2:3:4', '-5', '1.5:00', '1:ab']) {
      expect(parseBookmarkTime(text), isNull, reason: text);
    }
  });
}
