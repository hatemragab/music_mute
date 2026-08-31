import 'dart:convert';

import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

import 'job.dart';

/// sqflite DAO for job history.
///
/// Spec schema: jobs(id TEXT PRIMARY KEY, status TEXT, progress INTEGER,
/// stage TEXT, data TEXT json, createdAt INTEGER).
/// Extra indexed columns are kept for filtered queries without JSON parsing;
/// `data` holds the full Job JSON (lossless). Implements spec method names
/// plus compat aliases so callers using either naming keep working.
///
/// Spec methods: initDb, insertJob, getJobs, getJob, updateJob, deleteJob
/// Compat aliases: open, upsert, listRaw, delete, close
class JobDao {
  JobDao._(this._db);
  final Database _db;

  Database get db => _db;

  static const _table = 'jobs';

  // ---------------------------------------------------------------------------
  // Spec-required API (instance methods that match spec names)
  // ---------------------------------------------------------------------------

  /// Spec: `initDb()` — instance accessor that returns the underlying db
  /// (useful when caller kept a JobDao and needs the db handle).
  Future<Database> initDb() async => _db;

  Future<void> insertJob(Job job) => upsert(job);

  Future<List<Job>> getJobs({int? limit, int? offset}) async {
    final rows = await _db.query(_table,
        orderBy: 'createdAt DESC', limit: limit, offset: offset);
    return rows.map(_rowToJob).toList();
  }

  Future<Job?> getJob(String id) async {
    final rows =
        await _db.query(_table, where: 'id = ?', whereArgs: [id], limit: 1);
    if (rows.isEmpty) return null;
    return _rowToJob(rows.first);
  }

  Future<int> updateJob(Job job) async {
    return _db.update(
      _table,
      {
        'status': job.status.wire,
        'progress': job.progress,
        'stage': job.stage,
        'data': jsonEncode(job.toJson()),
      },
      where: 'id = ?',
      whereArgs: [job.jobId],
    );
  }

  Future<int> deleteJob(String id) => delete(id);

  // ---------------------------------------------------------------------------
  // Static open — creates DB with spec schema (plus compat extras)
  // ---------------------------------------------------------------------------

  static Future<JobDao> open({String fileName = 'vocal_remover.db'}) async {
    final dbPath = p.join(await getDatabasesPath(), fileName);
    final db = await openDatabase(
      dbPath,
      version: 1,
      onCreate: (db, version) async {
        // Spec schema: id, status, progress, stage, data, createdAt
        // Keep created_at alias + extras for backward compat with existing queries
        await db.execute('''
          CREATE TABLE $_table (
            id TEXT PRIMARY KEY,
            job_id TEXT,
            status TEXT NOT NULL,
            progress INTEGER NOT NULL DEFAULT 0,
            stage TEXT NOT NULL DEFAULT 'queued',
            model TEXT,
            data TEXT NOT NULL,
            createdAt INTEGER NOT NULL,
            created_at TEXT,
            finished_at TEXT,
            error TEXT
          )
        ''');
        await db.execute(
            'CREATE INDEX idx_jobs_createdAt ON $_table(createdAt DESC)');
        await db.execute('CREATE INDEX idx_jobs_status ON $_table(status)');
      },
    );
    return JobDao._(db);
  }

  /// Static helper matching spec's `initDb()` at top-level: opens default db.
  static Future<Database> initDbStatic(
      {String fileName = 'vocal_remover.db'}) async {
    final dao = await open(fileName: fileName);
    return dao._db;
  }

  // ---------------------------------------------------------------------------
  // Compat / convenience
  // ---------------------------------------------------------------------------

  Future<void> upsert(Job job) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    await _db.insert(
      _table,
      {
        'id': job.jobId,
        'job_id': job.jobId,
        'status': job.status.wire,
        'progress': job.progress,
        'stage': job.stage,
        'model': job.model,
        'data': jsonEncode(job.toJson()),
        'createdAt': job.createdAt?.millisecondsSinceEpoch ?? now,
        'created_at': job.createdAt?.toIso8601String(),
        'finished_at': job.finishedAt?.toIso8601String(),
        'error': job.error,
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<List<Map<String, Object?>>> listRaw() =>
      _db.query(_table, orderBy: 'createdAt DESC');

  Future<int> delete(String jobId) => _db
      .delete(_table, where: 'id = ? OR job_id = ?', whereArgs: [jobId, jobId]);

  Future<void> close() => _db.close();

  Job _rowToJob(Map<String, Object?> row) {
    final raw = row['data'] as String?;
    if (raw != null && raw.isNotEmpty) {
      return Job.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    }
    // Fallback: reconstruct from columns (old rows without data)
    return Job.fromJson({
      'job_id': row['id'] ?? row['job_id'],
      'status': row['status'],
      'progress': row['progress'],
      'stage': row['stage'],
      'model': row['model'],
      'created_at': row['created_at'] ?? row['createdAt'],
      'finished_at': row['finished_at'],
      'error': row['error'],
    });
  }
}
