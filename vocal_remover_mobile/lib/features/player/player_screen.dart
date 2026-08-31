import 'package:flutter/material.dart';
import 'package:just_audio/just_audio.dart';

class PlayerScreen extends StatefulWidget {
  const PlayerScreen({super.key});

  @override
  State<PlayerScreen> createState() => _PlayerScreenState();
}

class _PlayerScreenState extends State<PlayerScreen> {
  final _player = AudioPlayer();
  String? _url;
  bool _ready = false;
  String? _error;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final arg = ModalRoute.of(context)?.settings.arguments;
    final url =
        arg is String ? arg : (arg is Map ? arg['url']?.toString() : null);
    if (url != null && url.isNotEmpty && url != _url) {
      _url = url;
      _init(url);
    }
  }

  Future<void> _init(String url) async {
    setState(() {
      _ready = false;
      _error = null;
    });
    try {
      await _player.setUrl(url);
      if (!mounted) return;
      setState(() => _ready = true);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    }
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final url = _url ?? (ModalRoute.of(context)?.settings.arguments as String?);
    return Scaffold(
      appBar: AppBar(title: const Text('Player')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (url != null)
              Text(url,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 16),
            if (_error != null)
              Text('Error: $_error',
                  style: TextStyle(color: Theme.of(context).colorScheme.error))
            else if (!_ready)
              const Center(
                  child: Padding(
                      padding: EdgeInsets.all(16),
                      child: CircularProgressIndicator()))
            else
              _Controls(player: _player),
          ],
        ),
      ),
    );
  }
}

class _Controls extends StatelessWidget {
  const _Controls({required this.player});
  final AudioPlayer player;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<PlayerState>(
      stream: player.playerStateStream,
      builder: (context, snap) {
        final state = snap.data;
        final playing = state?.playing ?? false;
        final processing = state?.processingState;

        return Column(
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                IconButton(
                  iconSize: 48,
                  icon: Icon(playing
                      ? Icons.pause_circle_filled
                      : Icons.play_circle_filled),
                  onPressed: () {
                    if (playing) {
                      player.pause();
                    } else {
                      player.play();
                    }
                  },
                ),
                IconButton(
                  icon: const Icon(Icons.stop),
                  onPressed: () => player.stop(),
                ),
              ],
            ),
            if (processing == ProcessingState.loading ||
                processing == ProcessingState.buffering)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: LinearProgressIndicator(),
              ),
            const SizedBox(height: 12),
            StreamBuilder<Duration>(
              stream: player.positionStream,
              builder: (context, posSnap) {
                final pos = posSnap.data ?? Duration.zero;
                final dur = player.duration ?? Duration.zero;
                final maxMs = dur.inMilliseconds.toDouble();
                final posMs =
                    pos.inMilliseconds.clamp(0, dur.inMilliseconds).toDouble();
                return Column(
                  children: [
                    Slider(
                      min: 0,
                      max: maxMs > 0 ? maxMs : 1,
                      value: maxMs > 0 ? posMs : 0,
                      onChanged: maxMs > 0
                          ? (v) =>
                              player.seek(Duration(milliseconds: v.round()))
                          : null,
                    ),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(_fmt(pos)),
                        Text(_fmt(dur)),
                      ],
                    ),
                  ],
                );
              },
            ),
          ],
        );
      },
    );
  }

  String _fmt(Duration d) {
    final m = d.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    if (d.inHours > 0) return '${d.inHours}:$m:$s';
    return '$m:$s';
  }
}
