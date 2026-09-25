"""Single-process yt-dlp CLI with mandatory transport and audio guards."""
import resource
import sys
from network_guard import install


def main():
    resource.setrlimit(resource.RLIMIT_FSIZE, (50_000_000, 50_000_000))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    install()
    # Import the checksum-verified official zip executable, including its EJS.
    sys.path.insert(0, '/usr/local/bin/yt-dlp')
    import yt_dlp
    from yt_dlp.utils import DownloadError
    from yt_dlp.downloader.external import FFmpegFD

    def no_external_transfer(*args, **kwargs):
        raise DownloadError('AUDIO_FORMAT_UNAVAILABLE')

    # HLS can otherwise silently fall back from native handling to FFmpeg.
    # External processes must never bypass the guarded Python network stack.
    FFmpegFD.real_download = no_external_transfer

    base = yt_dlp.YoutubeDL

    class AudioOnlyDL(base):
        def process_ie_result(self, result, *args, **kwargs):
            if result.get('_type') in {'playlist', 'multi_video'}:
                raise DownloadError('SINGLE_ITEM_REQUIRED')
            return super().process_ie_result(result, *args, **kwargs)

        def process_info(self, info):
            if (info.get('vcodec') != 'none' or info.get('acodec') in {None, 'none'}
                    or info.get('requested_formats') or info.get('has_drm')
                    or info.get('protocol') not in
                    {'http', 'https', 'm3u8_native', 'http_dash_segments'}):
                raise DownloadError('AUDIO_FORMAT_UNAVAILABLE')
            return super().process_info(info)

    yt_dlp.YoutubeDL = AudioOnlyDL
    yt_dlp.main(sys.argv[1:])


if __name__ == '__main__':
    main()
