import 'package:flutter/material.dart';

/// Shows separation progress with [LinearProgressIndicator], stage and model.
///
/// Used by [JobDetailScreen] and inline job lists.
class ProgressCard extends StatelessWidget {
  const ProgressCard({
    super.key,
    required this.progress,
    required this.stage,
    required this.model,
    this.status,
  });

  /// 0..100 (clamped). Values outside the range are clamped for the bar.
  final int progress;

  /// Human-readable stage e.g. "separating", "encoding", "done".
  final String stage;

  /// Backend model e.g. "UVR-MDX-NET-Inst_HQ_3".
  final String model;

  /// Optional overall status e.g. "queued" / "processing" / "done" / "failed".
  final String? status;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final pct = progress.clamp(0, 100);
    final isDone = (status ?? stage) == 'done';
    final isFailed = (status ?? stage) == 'failed';

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    stage.isEmpty ? 'queued' : stage,
                    style: theme.textTheme.titleMedium,
                  ),
                ),
                Chip(
                  label: Text(model, style: theme.textTheme.labelSmall),
                  visualDensity: VisualDensity.compact,
                  materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
              ],
            ),
            if (status != null && status != stage) ...[
              const SizedBox(height: 4),
              Text(
                status!,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
            const SizedBox(height: 12),
            ClipRRect(
              borderRadius: BorderRadius.circular(999),
              child: LinearProgressIndicator(
                value: isDone ? 1 : (isFailed ? null : pct / 100),
                minHeight: 8,
                backgroundColor: theme.colorScheme.surfaceContainerHighest,
              ),
            ),
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  isDone
                      ? 'Done'
                      : isFailed
                          ? 'Failed'
                          : '$pct%',
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: isFailed ? theme.colorScheme.error : null,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Text(
                  '$pct / 100',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
