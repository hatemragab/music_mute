import 'package:shared_preferences/shared_preferences.dart';

/// Persists app settings via [SharedPreferences].
///
/// Currently stores only the backend base URL under key `backend_url`.
class SettingsService {
  SettingsService(this._prefs);

  final SharedPreferences _prefs;

  static const backendUrlKey = 'backend_url';
  static const defaultBackendUrl = 'https://<CLOUD_RUN_URL>';

  /// Cached factory — call once at startup if needed.
  static Future<SettingsService> create() async {
    final prefs = await SharedPreferences.getInstance();
    return SettingsService(prefs);
  }

  String getBackendUrl() =>
      _prefs.getString(backendUrlKey) ?? defaultBackendUrl;

  Future<bool> setBackendUrl(String url) =>
      _prefs.setString(backendUrlKey, url);
}
