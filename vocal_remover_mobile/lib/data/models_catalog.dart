import '../core/api_client.dart';

/// Fetches available separation models from GET /api/v1/models.
class ModelsCatalog {
  ModelsCatalog(this._api);
  final ApiClient _api;

  Future<List<Map<String, dynamic>>> fetch() async {
    final res = await _api.getModels();
    return (res.data ?? []).cast<Map<String, dynamic>>();
  }
}
