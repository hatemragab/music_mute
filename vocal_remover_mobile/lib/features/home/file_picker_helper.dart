import 'package:file_picker/file_picker.dart';

/// Helper for selecting audio and video files for stem separation.
class FilePickerHelper {
  FilePickerHelper._();

  /// Allowed file extensions covering common audio and video formats.
  static const List<String> allowedExtensions = [
    'mp3',
    'wav',
    'flac',
    'm4a',
    'ogg',
    'opus',
    'aac',
    'aiff',
    'mp4',
    'mkv',
    'mov',
    'avi',
    'webm',
  ];

  /// Opens the system file picker allowing the user to select an audio or video file.
  static Future<PlatformFile?> pickAudioOrVideoFile({
    FilePicker? picker,
  }) async {
    final filePicker = picker ?? FilePicker.platform;
    final result = await filePicker.pickFiles(
      type: FileType.custom,
      allowedExtensions: allowedExtensions,
    );
    if (result != null && result.files.isNotEmpty) {
      return result.files.first;
    }
    return null;
  }
}
