import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'file_picker_helper.dart';

class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  final _youtubeController = TextEditingController();

  PlatformFile? _selectedFile;
  String _selectedModel = 'UVR-MDX-NET-Inst_HQ_3';
  String _selectedStems = '2stems';

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    _youtubeController.dispose();
    super.dispose();
  }

  Future<void> _pickFile() async {
    final picked = await FilePickerHelper.pickAudioOrVideoFile();
    if (picked != null) {
      setState(() {
        _selectedFile = picked;
      });
    }
  }

  void _clearFile() {
    setState(() {
      _selectedFile = null;
    });
  }

  String _formatFileSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Vocal Remover'),
        actions: [
          IconButton(
            icon: const Icon(Icons.history),
            tooltip: 'Job History',
            onPressed: () => Navigator.pushNamed(context, '/jobs'),
          ),
          IconButton(
            icon: const Icon(Icons.settings),
            tooltip: 'Settings',
            onPressed: () => Navigator.pushNamed(context, '/settings'),
          ),
        ],
        bottom: TabBar(
          controller: _tabController,
          tabs: const [
            Tab(icon: Icon(Icons.audio_file), text: 'File'),
            Tab(icon: Icon(Icons.video_library), text: 'YouTube URL'),
          ],
        ),
      ),
      body: Column(
        children: [
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                _buildFileTab(theme),
                _buildYouTubeTab(theme),
              ],
            ),
          ),
          _buildOptionsAndSubmit(theme),
        ],
      ),
    );
  }

  Widget _buildFileTab(ThemeData theme) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Card(
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: _pickFile,
              child: Padding(
                padding:
                    const EdgeInsets.symmetric(vertical: 32, horizontal: 16),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      _selectedFile == null
                          ? Icons.cloud_upload_outlined
                          : Icons.check_circle_outline,
                      size: 48,
                      color: _selectedFile == null
                          ? theme.colorScheme.primary
                          : theme.colorScheme.tertiary,
                    ),
                    const SizedBox(height: 12),
                    Text(
                      _selectedFile == null
                          ? 'Choose audio or video file'
                          : _selectedFile!.name,
                      style: theme.textTheme.titleMedium,
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 6),
                    Text(
                      _selectedFile == null
                          ? 'Supported: MP3, WAV, FLAC, M4A, MP4, MKV, MOV, WEBM...'
                          : _formatFileSize(_selectedFile!.size),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                      textAlign: TextAlign.center,
                    ),
                    if (_selectedFile != null) ...[
                      const SizedBox(height: 12),
                      OutlinedButton.icon(
                        onPressed: _clearFile,
                        icon: const Icon(Icons.close, size: 18),
                        label: const Text('Change File'),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildYouTubeTab(ThemeData theme) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            controller: _youtubeController,
            decoration: const InputDecoration(
              labelText: 'YouTube Video URL',
              hintText: 'https://www.youtube.com/watch?v=...',
              prefixIcon: Icon(Icons.link),
              border: OutlineInputBorder(),
            ),
            keyboardType: TextInputType.url,
          ),
          const SizedBox(height: 8),
          Text(
            'Paste a YouTube URL to download and separate audio.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildOptionsAndSubmit(ThemeData theme) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.3),
        border: Border(
          top: BorderSide(
            color: theme.colorScheme.outlineVariant,
            width: 1,
          ),
        ),
      ),
      child: SafeArea(
        top: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DropdownButtonFormField<String>(
              isExpanded: true,
              initialValue: _selectedModel,
              decoration: const InputDecoration(
                labelText: 'Model',
                border: OutlineInputBorder(),
                contentPadding:
                    EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              ),
              items: const [
                DropdownMenuItem(
                  value: 'UVR-MDX-NET-Inst_HQ_3',
                  child: Text(
                    'MDX-Net HQ (Fast)',
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                DropdownMenuItem(
                  value: 'Kim_Vocal_2',
                  child: Text(
                    'Kim Vocal 2 (Vocals)',
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                DropdownMenuItem(
                  value: 'htdemucs',
                  child: Text(
                    'HTDemucs (4-Stem)',
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
              onChanged: (val) {
                if (val != null) {
                  setState(() => _selectedModel = val);
                }
              },
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              isExpanded: true,
              initialValue: _selectedStems,
              decoration: const InputDecoration(
                labelText: 'Stems',
                border: OutlineInputBorder(),
                contentPadding:
                    EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              ),
              items: const [
                DropdownMenuItem(
                  value: '2stems',
                  child: Text(
                    '2 Stems (Vocals + Inst)',
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                DropdownMenuItem(
                  value: 'vocals',
                  child: Text(
                    'Vocals Only',
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                DropdownMenuItem(
                  value: '4stems',
                  child: Text(
                    '4 Stems',
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
              onChanged: (val) {
                if (val != null) {
                  setState(() => _selectedStems = val);
                }
              },
            ),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: () {
                // Submit separation job
              },
              icon: const Icon(Icons.call_split),
              label: const Text('Separate'),
            ),
          ],
        ),
      ),
    );
  }
}
