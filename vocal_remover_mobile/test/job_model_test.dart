import 'package:flutter_test/flutter_test.dart';
import 'package:vocal_remover_mobile/data/job.dart';

void main() {
  group('JobStatus & JobStatusX', () {
    test('fromString parses all valid statuses correctly', () {
      expect(JobStatusX.fromString('queued'), equals(JobStatus.queued));
      expect(JobStatusX.fromString('processing'), equals(JobStatus.processing));
      expect(JobStatusX.fromString('done'), equals(JobStatus.done));
      expect(JobStatusX.fromString('failed'), equals(JobStatus.failed));
    });

    test('fromString throws on unknown status', () {
      expect(
        () => JobStatusX.fromString('unknown_status'),
        throwsA(isA<ArgumentError>()),
      );
    });

    test('wire property returns status name', () {
      expect(JobStatus.queued.wire, equals('queued'));
      expect(JobStatus.processing.wire, equals('processing'));
      expect(JobStatus.done.wire, equals('done'));
      expect(JobStatus.failed.wire, equals('failed'));
    });
  });

  group('JobResult / ResultItem', () {
    test('fromJson and toJson roundtrip', () {
      final json = {
        'stem': 'vocals',
        'url': 'https://example.com/vocals.mp3',
        'size_bytes': 1024000,
        'duration_s': 180.5,
      };

      final result = JobResult.fromJson(json);
      expect(result.stem, equals('vocals'));
      expect(result.url, equals('https://example.com/vocals.mp3'));
      expect(result.sizeBytes, equals(1024000));
      expect(result.durationS, equals(180.5));

      final serialized = result.toJson();
      expect(serialized['stem'], equals('vocals'));
      expect(serialized['url'], equals('https://example.com/vocals.mp3'));
      expect(serialized['size_bytes'], equals(1024000));
      expect(serialized['duration_s'], equals(180.5));
    });

    test('fromJson handles optional fields as null', () {
      final json = {
        'stem': 'instrumental',
        'url': 'https://example.com/instrumental.mp3',
      };

      final result = ResultItem.fromJson(json);
      expect(result.stem, equals('instrumental'));
      expect(result.url, equals('https://example.com/instrumental.mp3'));
      expect(result.sizeBytes, isNull);
      expect(result.durationS, isNull);

      final serialized = result.toJson();
      expect(serialized.containsKey('size_bytes'), isFalse);
      expect(serialized.containsKey('duration_s'), isFalse);
    });
  });

  group('Job', () {
    test('fromJson parses complete job JSON', () {
      final now = DateTime.utc(2026, 8, 31, 12, 0, 0);
      final json = {
        'job_id': 'job-123',
        'status': 'done',
        'progress': 100,
        'stage': 'completed',
        'model': 'htdemucs',
        'stems': ['vocals', 'drums', 'bass', 'other'],
        'results': [
          {
            'stem': 'vocals',
            'url': 'https://example.com/vocals.mp3',
            'size_bytes': 2048,
            'duration_s': 120.0,
          },
        ],
        'error': null,
        'created_at': now.toIso8601String(),
        'finished_at': now.add(const Duration(minutes: 2)).toIso8601String(),
      };

      final job = Job.fromJson(json);
      expect(job.jobId, equals('job-123'));
      expect(job.status, equals(JobStatus.done));
      expect(job.progress, equals(100));
      expect(job.stage, equals('completed'));
      expect(job.model, equals('htdemucs'));
      expect(job.stems, equals(['vocals', 'drums', 'bass', 'other']));
      expect(job.results.length, equals(1));
      expect(job.results.first.stem, equals('vocals'));
      expect(job.error, isNull);
      expect(job.createdAt, equals(now));
      expect(job.finishedAt, equals(now.add(const Duration(minutes: 2))));
    });

    test(
        'fromJson parses alternative keys: jobId / id, integer epoch timestamps',
        () {
      const createdAtMillis = 1700000000000;
      final json = {
        'id': 'job-alt-456',
        'status': 'processing',
        'progress': 50,
        'createdAt': createdAtMillis,
      };

      final job = Job.fromJson(json);
      expect(job.jobId, equals('job-alt-456'));
      expect(job.status, equals(JobStatus.processing));
      expect(job.progress, equals(50));
      expect(job.createdAt,
          equals(DateTime.fromMillisecondsSinceEpoch(createdAtMillis)));
    });

    test('toJson serializes correctly', () {
      final createdAt = DateTime.utc(2026, 8, 31, 10, 0, 0);
      final job = Job(
        jobId: 'job-789',
        status: JobStatus.failed,
        progress: 30,
        stage: 'inferencing',
        model: 'UVR-MDX-NET-Inst_HQ_3',
        stems: const ['vocals', 'no_vocals'],
        results: const [],
        error: 'CUDA Out of Memory',
        createdAt: createdAt,
      );

      final json = job.toJson();
      expect(json['job_id'], equals('job-789'));
      expect(json['status'], equals('failed'));
      expect(json['progress'], equals(30));
      expect(json['stage'], equals('inferencing'));
      expect(json['model'], equals('UVR-MDX-NET-Inst_HQ_3'));
      expect(json['stems'], equals(['vocals', 'no_vocals']));
      expect(json['results'], isEmpty);
      expect(json['error'], equals('CUDA Out of Memory'));
      expect(json['created_at'], equals(createdAt.toIso8601String()));
      expect(json.containsKey('finished_at'), isFalse);
    });

    test('copyWith updates properties and retains unchanged ones', () {
      const job = Job(
        jobId: 'job-1',
        status: JobStatus.queued,
        progress: 0,
      );

      final updated = job.copyWith(
        status: JobStatus.processing,
        progress: 45,
        stage: 'separating',
      );

      expect(updated.jobId, equals('job-1'));
      expect(updated.status, equals(JobStatus.processing));
      expect(updated.progress, equals(45));
      expect(updated.stage, equals('separating'));
    });
  });
}
