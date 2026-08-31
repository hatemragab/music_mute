import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/theme.dart';
import 'features/home/home_screen.dart';
import 'features/jobs/jobs_screen.dart';
import 'features/jobs/job_detail_screen.dart';
import 'features/player/player_screen.dart';
import 'features/settings/settings_screen.dart';

class App extends ConsumerWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp(
      title: 'Vocal Remover',
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      themeMode: ThemeMode.system,
      home: const HomeScreen(),
      routes: {
        '/jobs': (_) => const JobsScreen(),
        '/job-detail': (_) => const JobDetailScreen(),
        '/player': (_) => const PlayerScreen(),
        '/settings': (_) => const SettingsScreen(),
      },
    );
  }
}
