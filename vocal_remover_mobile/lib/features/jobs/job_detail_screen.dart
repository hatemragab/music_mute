import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/job.dart';
import '../../data/job_dao.dart';
import '../../widgets/progress_card.dart';
import '../../widgets/stem_tile.dart';
import 'jobs_controller.dart';

class JobDetailScreen extends ConsumerStatefulWidget {
  const JobDetailScreen({super.key});

  @override
  ConsumerState<JobDetailScreen> createState() => _JobDetailScreenState();
}

class _JobDetailScreenState extends ConsumerState<JobDetailScreen> {
  String? _jobId;
  bool _didInitPolling = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final arg = ModalRoute.of(context)?.settings.arguments;
    final id =
        arg is String ? arg : (arg is Map ? arg['jobId']?.toString() : null);
    if (id != null && id.isNotEmpty && id != _jobId) {
      _jobId = id;
      // Defer polling start until after first frame so ref is ready.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_didInitPolling && mounted) {
          _didInitPolling = true;
          ref.read(jobsControllerProvider.notifier).startPolling(id);
        }
      });
    }
  }

  @override
  void dispose() {
    // Don't stop polling globally — other screens may rely on it; but stop this instance's timer.
    // JobsController owns the timer and cancels on provider dispose.
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final jobId =
        _jobId ?? (ModalRoute.of(context)?.settings.arguments as String?);
    final controllerState = ref.watch(jobsControllerProvider);

    return Scaffold(
      appBar: AppBar(title: Text(jobId ?? 'Job detail')),
      body: FutureBuilder<Job?>(
        future: jobId == null ? Future.value(null) : _loadLocal(jobId),
        builder: (context, snap) {
          // Prefer live polled job over local cache.
          final liveJob = controllerState.valueOrNull;
          final localJob = snap.data;
          final job = liveJob ?? localJob;

          if (controllerState is AsyncLoading && job == null) {
            return const Center(child: CircularProgressIndicator());
          }
          if (job == null) {
            if (controllerState.hasError) {
              return Center(child: Text('Error: ${controllerState.error}'));
            }
            if (snap.connectionState == ConnectionState.waiting) {
              return const Center(child: CircularProgressIndicator());
            }
            return const Center(
                child: Text('Job not found locally. Waiting for updates…'));
          }

          return ListView(
            padding: const EdgeInsets.only(bottom: 24),
            children: [
              ProgressCard(
                progress: job.progress,
                stage: job.stage,
                model: job.model,
                status: job.status.wire,
              ),
              if (job.error != null) ...[
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Text(
                    job.error!,
                    style:
                        TextStyle(color: Theme.of(context).colorScheme.error),
                  ),
                ),
              ],
              if (job.results.isNotEmpty) ...[
                const SizedBox(height: 8),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Text('Stems',
                      style: Theme.of(context).textTheme.titleMedium),
                ),
                const SizedBox(height: 8),
                for (final r in job.results)
                  StemTile(
                    stem: r.stem,
                    url: r.url,
                    durationS: r.durationS,
                    sizeBytes: r.sizeBytes,
                  ),
              ] else if (job.status == JobStatus.done) ...[
                const Padding(
                  padding: EdgeInsets.all(16),
                  child: Text('No stems returned for this job.'),
                ),
              ],
            ],
          );
        },
      ),
    );
  }

  Future<Job?> _loadLocal(String id) async {
    final dao = await JobDao.open();
    try {
      return await dao.getJob(id);
    } finally {
      await dao.close();
    }
  }
}
