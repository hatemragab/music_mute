import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import 'settings.dart';

/// Dio-backed API client. Base URL is read from [SettingsService].
///
/// All endpoints are under `/api/v1` (PLAN section 4).
/// - POST /separate -> 202 {job_id, status: queued}
/// - GET  /jobs/{id} -> job doc from MongoDB
/// - GET  /models
/// - GET  /results/{jobId}/{filename} -> 302 to S3 presigned URL
/// - GET  /health
class ApiClient {
  ApiClient({required SettingsService settings, Dio? dio})
      : _settings = settings,
        _dio = (dio ?? Dio()) {
    // Apply required timeouts — send 120s (upload), receive 60s, connect 30s.
    _dio.options.connectTimeout ??= const Duration(seconds: 30);
    _dio.options.receiveTimeout ??= const Duration(seconds: 60);
    _dio.options.sendTimeout ??= const Duration(seconds: 120);

    // Log interceptor (debug only). Added once.
    if (kDebugMode) {
      final hasLog = _dio.interceptors.any((e) => e is LogInterceptor);
      if (!hasLog) {
        _dio.interceptors.add(
          LogInterceptor(
            request: true,
            requestHeader: false,
            requestBody: false,
            responseHeader: false,
            responseBody: true,
            error: true,
            logPrint: (obj) => _log(obj.toString()),
          ),
        );
      }
    }
  }

  final SettingsService _settings;
  final Dio _dio;

  String get _baseUrl => _settings.getBackendUrl();

  /// Expose underlying Dio (spec: Dio dio).
  Dio get dio => _dio;

  /// Back-compat alias for spec's `baseUrl` field — derived from settings.
  String get baseUrl => _baseUrl;

  static void _log(String msg) {
    // ignore: avoid_print
    print('[ApiClient] $msg');
  }

  /// POST /api/v1/separate  (multipart)
  ///
  /// Provide exactly one of file ([file] or [filePath]) or [youtubeUrl].
  /// [model] defaults to UVR-MDX-NET-Inst_HQ_3 (PLAN 3.1).
  /// [stems] one of vocals | 2stems | 4stems (PLAN 4).
  /// Returns raw [Response] on 200/202; throws [DioException] with
  /// descriptive message on 400/429 (and other 4xx).
  Future<Response<Map<String, dynamic>>> separate({
    File? file,
    String? filePath,
    String? youtubeUrl,
    String model = 'UVR-MDX-NET-Inst_HQ_3',
    String stems = '2stems',
    ProgressCallback? onSendProgress,
  }) async {
    final hasFile = file != null || filePath != null;
    final hasUrl = youtubeUrl != null && youtubeUrl.isNotEmpty;
    assert(
        hasFile ^ hasUrl, 'Provide exactly one of file/filePath or youtubeUrl');

    final formData = FormData();
    formData.fields.add(MapEntry('model', model));
    formData.fields.add(MapEntry('stems', stems));

    if (hasUrl) {
      formData.fields.add(MapEntry('youtube_url', youtubeUrl));
    }
    if (file != null) {
      final filename = file.path.split(Platform.pathSeparator).last;
      formData.files.add(
        MapEntry('file',
            await MultipartFile.fromFile(file.path, filename: filename)),
      );
    } else if (filePath != null) {
      formData.files.add(
        MapEntry('file', await MultipartFile.fromFile(filePath)),
      );
    }

    final resp = await _dio.post<Map<String, dynamic>>(
      '$_baseUrl/api/v1/separate',
      data: formData,
      onSendProgress: onSendProgress,
      options: Options(validateStatus: (c) => c != null && c < 400),
    );
    _throwIfError(resp);
    return resp;
  }

  Future<Response<Map<String, dynamic>>> getJob(String jobId) async {
    final resp = await _dio.get<Map<String, dynamic>>(
      '$_baseUrl/api/v1/jobs/$jobId',
      options: Options(validateStatus: (c) => c != null && c < 400),
    );
    _throwIfError(resp);
    return resp;
  }

  Future<Response<List<dynamic>>> getModels() async {
    final resp = await _dio.get<List<dynamic>>(
      '$_baseUrl/api/v1/models',
      options: Options(validateStatus: (c) => c != null && c < 400),
    );
    // getModels may return 200 with List; error handling via DioException for 4xx/5xx
    return resp;
  }

  /// GET /api/v1/health — spec required.
  Future<Response<Map<String, dynamic>>> health() async {
    final resp = await _dio.get<Map<String, dynamic>>(
      '$_baseUrl/api/v1/health',
      options: Options(validateStatus: (c) => c != null && c < 400),
    );
    _throwIfError(resp);
    return resp;
  }

  /// Convenience: build a result URL (302 to S3 presigned URL on backend).
  String resultUrl(String jobId, String filename) =>
      '$_baseUrl/api/v1/results/$jobId/$filename';

  // ---------------------------------------------------------------------------
  // Error helpers — surface 400/429 with detail from body (spec requirement).
  // 202 is success (queued) alongside 200.
  // ---------------------------------------------------------------------------

  void _throwIfError(Response<Map<String, dynamic>> resp) {
    final code = resp.statusCode ?? 0;
    if (code == 200 || code == 202) return;
    throw DioException(
      requestOptions: resp.requestOptions,
      response: resp,
      type: DioExceptionType.badResponse,
      error: _errorMessage(code, resp.data),
    );
  }

  String _errorMessage(int code, dynamic data) {
    final detail = data is Map && data['detail'] != null
        ? data['detail'].toString()
        : data?.toString() ?? 'Unknown error';
    switch (code) {
      case 400:
        return 'Bad request (400): $detail';
      case 404:
        return 'Not found (404): $detail';
      case 413:
        return 'Payload too large (413): $detail';
      case 429:
        return 'Rate limited (429): $detail';
      default:
        return 'HTTP $code: $detail';
    }
  }
}
