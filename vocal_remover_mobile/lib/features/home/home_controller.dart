import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Placeholder controller for Home. Wired to ApiClient when backend is configured.
class HomeController extends Notifier<AsyncValue<void>> {
  @override
  AsyncValue<void> build() => const AsyncData(null);
}

final homeControllerProvider =
    NotifierProvider<HomeController, AsyncValue<void>>(HomeController.new);
