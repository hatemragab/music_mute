import 'package:file_picker/file_picker.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vocal_remover_mobile/features/home/file_picker_helper.dart';

class FakeFilePicker extends FilePicker {
  FakeFilePicker({this.result});

  final FilePickerResult? result;
  FileType? lastType;
  List<String>? lastAllowedExtensions;

  @override
  Future<FilePickerResult?> pickFiles({
    String? dialogTitle,
    String? initialDirectory,
    FileType type = FileType.any,
    List<String>? allowedExtensions,
    Function(FilePickerStatus)? onFileLoading,
    bool allowCompression = true,
    int compressionQuality = 30,
    bool allowMultiple = false,
    bool withData = false,
    bool withReadStream = false,
    bool lockParentWindow = false,
    bool readSequential = false,
  }) async {
    lastType = type;
    lastAllowedExtensions = allowedExtensions;
    return result;
  }
}

void main() {
  group('FilePickerHelper', () {
    test('allowedExtensions contains audio and video formats', () {
      const exts = FilePickerHelper.allowedExtensions;
      const expected = [
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
      expect(exts, equals(expected));
    });

    test('pickAudioOrVideoFile passes custom type and allowed extensions',
        () async {
      final fakeFile = PlatformFile(
        name: 'sample_video.mp4',
        size: 1024 * 1024 * 5,
        path: '/path/to/sample_video.mp4',
      );
      final fakePicker = FakeFilePicker(
        result: FilePickerResult([fakeFile]),
      );

      final picked =
          await FilePickerHelper.pickAudioOrVideoFile(picker: fakePicker);

      expect(fakePicker.lastType, equals(FileType.custom));
      expect(fakePicker.lastAllowedExtensions,
          equals(FilePickerHelper.allowedExtensions));
      expect(picked, isNotNull);
      expect(picked!.name, equals('sample_video.mp4'));
      expect(picked.size, equals(5242880));
    });

    test('pickAudioOrVideoFile returns null when canceled', () async {
      final fakePicker = FakeFilePicker(result: null);

      final picked =
          await FilePickerHelper.pickAudioOrVideoFile(picker: fakePicker);

      expect(fakePicker.lastType, equals(FileType.custom));
      expect(picked, isNull);
    });
  });
}
