import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vocal_remover_mobile/core/settings.dart';
import 'package:vocal_remover_mobile/features/settings/settings_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('SettingsService', () {
    test('returns defaultBackendUrl when no value is stored', () async {
      SharedPreferences.setMockInitialValues({});
      final service = await SettingsService.create();

      expect(
          service.getBackendUrl(), equals(SettingsService.defaultBackendUrl));
    });

    test('returns custom URL when stored in SharedPreferences', () async {
      SharedPreferences.setMockInitialValues({
        SettingsService.backendUrlKey: 'https://custom-cloud-run.a.run.app',
      });
      final service = await SettingsService.create();

      expect(service.getBackendUrl(),
          equals('https://custom-cloud-run.a.run.app'));
    });

    test('setBackendUrl persists new URL', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final service = SettingsService(prefs);

      await service.setBackendUrl('https://new-api.example.com');
      expect(service.getBackendUrl(), equals('https://new-api.example.com'));
      expect(prefs.getString(SettingsService.backendUrlKey),
          equals('https://new-api.example.com'));
    });
  });

  group('settingsServiceProvider', () {
    test('resolves SettingsService with SharedPreferences', () async {
      SharedPreferences.setMockInitialValues({
        SettingsService.backendUrlKey: 'https://test-server.app',
      });

      final container = ProviderContainer();
      addTearDown(container.dispose);

      final settings = await container.read(settingsServiceProvider.future);
      expect(settings.getBackendUrl(), equals('https://test-server.app'));
    });
  });
}
