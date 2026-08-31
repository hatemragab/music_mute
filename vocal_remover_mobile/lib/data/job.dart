/// Job model mirroring GET /api/v1/jobs/{id} (PLAN section 4).
///
/// Spec requires: jobId, status enum (queued|processing|done|failed),
/// progress int 0..100, stage String, model String, stems List<String>,
/// results List<ResultItem>, error String?, createdAt/finishedAt.
/// Kept backward compatible with previous String-based Job on disk.
library;

// ---------------------------------------------------------------------------
// Status enum (spec)
// ---------------------------------------------------------------------------

enum JobStatus { queued, processing, done, failed }

extension JobStatusX on JobStatus {
  static JobStatus fromString(String v) {
    switch (v) {
      case 'queued':
        return JobStatus.queued;
      case 'processing':
        return JobStatus.processing;
      case 'done':
        return JobStatus.done;
      case 'failed':
        return JobStatus.failed;
      default:
        throw ArgumentError('Unknown JobStatus: $v');
    }
  }

  String get wire => name;
}

// ---------------------------------------------------------------------------
// Result item — spec calls it ResultItem; previous code used JobResult.
// Keep both names via typedef for compatibility.
// ---------------------------------------------------------------------------

class JobResult {
  const JobResult({
    required this.stem,
    required this.url,
    this.sizeBytes,
    this.durationS,
  });

  final String stem;
  final String url;
  final int? sizeBytes;
  final double? durationS;

  factory JobResult.fromJson(Map<String, dynamic> json) => JobResult(
        stem: json['stem'] as String,
        url: json['url'] as String,
        sizeBytes: (json['size_bytes'] as num?)?.toInt(),
        durationS: (json['duration_s'] as num?)?.toDouble(),
      );

  Map<String, dynamic> toJson() => {
        'stem': stem,
        'url': url,
        if (sizeBytes != null) 'size_bytes': sizeBytes,
        if (durationS != null) 'duration_s': durationS,
      };
}

/// Alias required by spec text (results List<ResultItem>)
typedef ResultItem = JobResult;

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

class Job {
  const Job({
    required this.jobId,
    required this.status,
    this.progress = 0,
    this.stage = 'queued',
    this.model = 'UVR-MDX-NET-Inst_HQ_3',
    this.stems = const [],
    this.results = const [],
    this.error,
    this.createdAt,
    this.finishedAt,
  });

  final String jobId;
  final JobStatus status;
  final int progress;
  final String stage;
  final String model;
  final List<String> stems;
  final List<JobResult> results;
  final String? error;
  final DateTime? createdAt;
  final DateTime? finishedAt;

  factory Job.fromJson(Map<String, dynamic> json) {
    final rawResults = json['results'] as List?;
    return Job(
      jobId: (json['job_id'] ?? json['jobId'] ?? json['id'] ?? '') as String,
      status: JobStatusX.fromString((json['status'] ?? 'queued') as String),
      progress: (json['progress'] as num?)?.toInt() ?? 0,
      stage: (json['stage'] ?? json['status'] ?? 'queued') as String,
      model: (json['model'] ?? 'UVR-MDX-NET-Inst_HQ_3') as String,
      stems: (json['stems'] as List?)?.map((e) => e.toString()).toList() ??
          const [],
      results: rawResults
              ?.map((e) => JobResult.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [],
      error: json['error'] as String?,
      createdAt: _parseDate(json['created_at'] ?? json['createdAt']),
      finishedAt: _parseDate(json['finished_at'] ?? json['finishedAt']),
    );
  }

  Map<String, dynamic> toJson() => {
        'job_id': jobId,
        'status': status.wire,
        'progress': progress,
        'stage': stage,
        'model': model,
        'stems': stems,
        'results': results.map((e) => e.toJson()).toList(),
        if (error != null) 'error': error,
        if (createdAt != null) 'created_at': createdAt!.toIso8601String(),
        if (finishedAt != null) 'finished_at': finishedAt!.toIso8601String(),
      };

  Job copyWith({
    String? jobId,
    JobStatus? status,
    int? progress,
    String? stage,
    String? model,
    List<String>? stems,
    List<JobResult>? results,
    String? error,
    DateTime? createdAt,
    DateTime? finishedAt,
  }) =>
      Job(
        jobId: jobId ?? this.jobId,
        status: status ?? this.status,
        progress: progress ?? this.progress,
        stage: stage ?? this.stage,
        model: model ?? this.model,
        stems: stems ?? this.stems,
        results: results ?? this.results,
        error: error ?? this.error,
        createdAt: createdAt ?? this.createdAt,
        finishedAt: finishedAt ?? this.finishedAt,
      );

  static DateTime? _parseDate(dynamic v) {
    if (v == null) return null;
    if (v is int) return DateTime.fromMillisecondsSinceEpoch(v);
    if (v is String && v.isNotEmpty) return DateTime.tryParse(v);
    return null;
  }
}
