import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/widgets/search/search_filter/video_length_fields.dart';

void main() {
  test('reads seconds, m:ss and h:mm:ss as milliseconds', () {
    expect(parseVideoLength('45').milliseconds, 45000);
    expect(parseVideoLength(' 1:30 ').milliseconds, 90000);
    expect(parseVideoLength('1:02:03').milliseconds, 3723000);
    expect(parseVideoLength(''), (milliseconds: null, invalid: false));
  });

  test('refuses what is not a length', () {
    expect(parseVideoLength('1.5'), (milliseconds: null, invalid: true));
    expect(parseVideoLength('abc').invalid, isTrue);
    expect(parseVideoLength('1:2:3:4').invalid, isTrue);
  });

  test('writes lengths as m:ss, or h:mm:ss from an hour on', () {
    expect(formatVideoLength(5000), '0:05');
    expect(formatVideoLength(90000), '1:30');
    expect(formatVideoLength(3723000), '1:02:03');
  });
}
