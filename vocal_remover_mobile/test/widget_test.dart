import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vocal_remover_mobile/app.dart';
import 'package:vocal_remover_mobile/features/home/home_screen.dart';

void main() {
  testWidgets('App renders HomeScreen with title and action buttons',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      const ProviderScope(
        child: App(),
      ),
    );

    // Verify HomeScreen is rendered with its title and navigation actions
    expect(find.byType(HomeScreen), findsOneWidget);
    expect(find.text('Vocal Remover'), findsOneWidget);
    expect(find.byIcon(Icons.history), findsOneWidget);
    expect(find.byIcon(Icons.settings), findsOneWidget);
    expect(find.text('Choose audio or video file'), findsOneWidget);
    expect(find.text('Separate'), findsOneWidget);
  });
}
