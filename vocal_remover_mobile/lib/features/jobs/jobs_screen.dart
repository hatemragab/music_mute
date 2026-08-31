import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/job.dart';
import '../../data/job_dao.dart';

final _jobsListProvider = FutureProvider<List<Job>>((ref) async {
  final dao = await JobDao.open();
  try {
    return await dao.getJobs();
  } finally {
    await dao.close();
  }
});

class JobsScreen extends ConsumerWidget {
  const JobsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Keep polling alive for the most recent active job, if any.
    final jobsAsync = ref.watch(_jobsListProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Jobs')),
      body: jobsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Error: $e')),
        data: (jobs) {
          if (jobs.isEmpty) {
            return const Center(
                child: Text('No jobs yet — separate a track from Home.'));
          }
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(_jobsListProvider),
            child: ListView.separated(
              padding: const EdgeInsets.symmetric(vertical: 8),
              itemCount: jobs.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (context, i) {
                final job = jobs[i];
                final isActive = job.status == JobStatus.queued ||
                    job.status == JobStatus.processing;
                return ListTile(
                  leading: _statusIcon(job.status),
                  title: Text(job.jobId,
                      maxLines: 1, overflow: TextOverflow.ellipsis),
                  subtitle: Text(
                    '${job.status.wire}  •  ${job.stage}  •  ${job.progress}%',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  trailing: isActive
                      ? SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            value: job.progress > 0 ? job.progress / 100 : null,
                          ),
                        )
                      : const Icon(Icons.chevron_right),
                  onTap: () => Navigator.pushNamed(
                    context,
                    '/job-detail',
                    arguments: job.jobId,
                  ),
                );
              },
            ),
          );
        },
      ),
    );
  }

  Widget _statusIcon(JobStatus s) {
    switch (s) {
      case JobStatus.queued:
        return const Icon(Icons.hourglass_top_outlined);
      case JobStatus.processing:
        return const Icon(Icons.sync);
      case JobStatus.done:
        return const Icon(Icons.check_circle_outline, color: Colors.green);
      case JobStatus.failed:
        return const Icon(Icons.error_outline, color: Colors.red);
    }
  }
}
