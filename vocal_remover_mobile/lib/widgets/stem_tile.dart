import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';

/// One result stem row: name / duration / size + Play / Download / Share.
///
/// * Play  → pushes `/player` with the stem URL as route argument.
/// * Download → `dio.download` into the app docs dir via path_provider.
/// * Share → placeholder snackbar (share_plus can be wired later).
class StemTile extends StatelessWidget {
  const StemTile({
    super.key,
    required this.stem,
    required this.url,
    this.durationS,
    this.sizeBytes,
    this.dio,
  });

  final String stem;
  final String url;
  final double? durationS;
  final int? sizeBytes;
  final Dio? dio;

  String _fmtDuration(double? s) {
    if (s == null) return '--:--';
    final total = s.round();
    final m = total ~/ 60;
    final sec = total % 60;
    return '$m:${sec.toString().padLeft(2, '0')}';
  }

  String _fmtSize(int? bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) {
      return '${(bytes / 1024).toStringAsFixed(1)} KB';
    }
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }

  Future<void> _download(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final dir = await getApplicationDocumentsDirectory();
      final filename =
          Uri.tryParse(url)?.pathSegments.lastOrNull ?? '$stem.mp3';
      final savePath = '${dir.path}/$filename';
      final client = dio ?? Dio();
      messenger.showSnackBar(
        SnackBar(content: Text('Downloading $filename…')),
      );
      await client.download(url, savePath);
      if (!context.mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text('Saved to $savePath')),
      );
    } catch (e) {
      if (!context.mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text('Download failed: $e')),
      );
    }
  }

  void _share(BuildContext context) {
    // Placeholder — wire share_plus when added to pubspec.
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Share $stem — coming soon')),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final subtitle = [
      _fmtDuration(durationS),
      if (sizeBytes != null) _fmtSize(sizeBytes),
    ].join('  •  ');

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: ListTile(
        leading: CircleAvatar(
          backgroundColor: theme.colorScheme.primaryContainer,
          child: Icon(Icons.music_note,
              color: theme.colorScheme.onPrimaryContainer),
        ),
        title: Text(stem, style: theme.textTheme.titleMedium),
        subtitle: Text(subtitle, style: theme.textTheme.bodySmall),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            IconButton(
              tooltip: 'Play',
              icon: const Icon(Icons.play_arrow),
              onPressed: () =>
                  Navigator.pushNamed(context, '/player', arguments: url),
            ),
            IconButton(
              tooltip: 'Download',
              icon: const Icon(Icons.download_outlined),
              onPressed: () => _download(context),
            ),
            IconButton(
              tooltip: 'Share',
              icon: const Icon(Icons.share_outlined),
              onPressed: () => _share(context),
            ),
          ],
        ),
      ),
    );
  }
}
