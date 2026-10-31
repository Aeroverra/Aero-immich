import 'package:crop_image/crop_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset_edit.model.dart';
import 'package:immich_mobile/presentation/pages/edit/edit.page.dart';
import 'package:immich_mobile/presentation/pages/edit/editor.provider.dart';
import 'package:immich_mobile/widgets/common/transparent_image.dart';

import '../presentation_context.dart';

class _OpenEditor extends EditorProvider {
  final bool rotateOnly;

  _OpenEditor({required this.rotateOnly});

  @override
  EditorState build() => EditorState(originalWidth: 1920, originalHeight: 1080, rotateOnly: rotateOnly);
}

void main() {
  late PresentationContext context;

  setUp(() async {
    context = await PresentationContext.create();
  });

  tearDown(() async {
    await context.dispose();
  });

  Future<List<List<AssetEdit>>> pumpEditor(WidgetTester tester, {required bool rotateOnly}) async {
    final saved = <List<AssetEdit>>[];
    await tester.pumpTestWidget(
      context,
      EditImagePage(image: Image.memory(kTransparentImage), applyEdits: (edits) async => saved.add(edits)),
      overrides: [editorStateProvider.overrideWith(() => _OpenEditor(rotateOnly: rotateOnly))],
    );
    return saved;
  }

  testWidgets('a video or motion photo can only be rotated', (tester) async {
    await pumpEditor(tester, rotateOnly: true);

    expect(find.byIcon(Icons.rotate_left), findsOneWidget);
    expect(find.byIcon(Icons.rotate_right), findsOneWidget);
    expect(find.byIcon(Icons.flip), findsNothing);
    expect(find.byType(CropImage), findsNothing);
    expect(find.text('Videos and motion photos can only be rotated.'), findsOneWidget);
  });

  testWidgets('saves only the rotation of a video', (tester) async {
    final saved = await pumpEditor(tester, rotateOnly: true);

    await tester.tap(find.byIcon(Icons.rotate_right));
    await tester.pumpAndSettle();
    await tester.tap(find.byIcon(Icons.done_rounded));
    await tester.pumpAndSettle();

    expect(saved, hasLength(1));
    expect(saved.single, hasLength(1));
    expect(saved.single.single, isA<RotateEdit>());
    expect((saved.single.single as RotateEdit).parameters.angle, 90);

    // let the success toast go away
    await tester.pump(const Duration(seconds: 4));
  });

  testWidgets('a photo keeps the full editor', (tester) async {
    await pumpEditor(tester, rotateOnly: false);

    expect(find.byIcon(Icons.flip), findsNWidgets(2));
    expect(find.byType(CropImage), findsOneWidget);
    expect(find.text('Videos and motion photos can only be rotated.'), findsNothing);
  });
}
