import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/settings.dart';
import '../../data/job.dart';
import '../../data/job_dao.dart';

/// Polls GET /api/v1/jobs/{id} every 3s until terminal state, persisting to sqflite.
class JobsController extends Notifier<AsyncValue<Job?>> {
  Timer? _timer;

  @override
  AsyncValue<Job?> build() {
    ref.onDispose(() => _timer?.cancel());
    return const AsyncData(null);
  }

  Future<void> startPolling(String jobId) async {
    _timer?.cancel();
    state = const AsyncLoading();
    // Immediate first fetch, then every 3s.
    await _pollOnce(jobId);
    _timer =
        Timer.periodic(const Duration(seconds: 3), (_) => _pollOnce(jobId));
  }

  void stopPolling() {
    _timer?.cancel();
    _timer = null;
  }

  Future<void> _pollOnce(String jobId) async {
    try {
      final settings = await SettingsService.create();
      final api = ApiClient(settings: settings);
      final resp = await api.getJob(jobId);
      final data = resp.data;
      if (data == null) return;
      final job = Job.fromJson(data);
      // Persist locally
      final dao = await JobDao.open();
      try {
        await dao.upsert(job);
      } finally {
        await dao.close();
      }
      state = AsyncData(job);
      if (job.status == JobStatus.done || job.status == JobStatus.failed) {
        stopPolling();
      }
    } catch (e, st) {
      state = AsyncError(e, st);
    }
  }
}

final jobsControllerProvider =
    NotifierProvider<JobsController, AsyncValue<Job?>>(JobsController.new);
