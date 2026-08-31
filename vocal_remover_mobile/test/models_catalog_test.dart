import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vocal_remover_mobile/core/api_client.dart';
import 'package:vocal_remover_mobile/core/settings.dart';
import 'package:vocal_remover_mobile/data/models_catalog.dart';

class FakeApiClient extends ApiClient {
  FakeApiClient({
    required super.settings,
    this.modelsResponse,
    this.statusCode = 200,
  });

  final List<dynamic>? modelsResponse;
  final int statusCode;

  @override
  Future<Response<List<dynamic>>> getModels() async {
    return Response<List<dynamic>>(
      data: modelsResponse,
      statusCode: statusCode,
      requestOptions: RequestOptions(path: '/api/v1/models'),
    );
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late SettingsService settings;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    settings = await SettingsService.create();
  });

  group('ModelsCatalog', () {
    test('fetch parses list of models from ApiClient', () async {
      final mockData = [
        {
          'id': 'UVR-MDX-NET-Inst_HQ_3',
          'name': 'UVR MDX-NET Inst HQ 3',
          'stems': ['vocals', 'instrumental'],
          'default': true,
        },
        {
          'id': 'htdemucs',
          'name': 'HTDemucs 4-Stems',
          'stems': ['vocals', 'drums', 'bass', 'other'],
          'default': false,
        },
      ];

      final fakeApi = FakeApiClient(
        settings: settings,
        modelsResponse: mockData,
      );
      final catalog = ModelsCatalog(fakeApi);

      final result = await catalog.fetch();
      expect(result.length, equals(2));
      expect(result[0]['id'], equals('UVR-MDX-NET-Inst_HQ_3'));
      expect(result[0]['default'], isTrue);
      expect(result[1]['id'], equals('htdemucs'));
      expect(result[1]['stems'], equals(['vocals', 'drums', 'bass', 'other']));
    });

    test('fetch returns empty list when response data is null', () async {
      final fakeApi = FakeApiClient(
        settings: settings,
        modelsResponse: null,
      );
      final catalog = ModelsCatalog(fakeApi);

      final result = await catalog.fetch();
      expect(result, isEmpty);
    });
  });
}
