import copy
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

import extract

try:
    from yt_dlp import YoutubeDL as InstalledYoutubeDL
    from yt_dlp.networking.common import Response as NativeResponse
    from yt_dlp.networking.exceptions import HTTPError
except ImportError:
    InstalledYoutubeDL = None


VIDEO_ID = 'fixture_123'
URL = 'https://www.youtube.com/watch?v=' + VIDEO_ID
PROXY = 'http://fixture-login:fixture-password@gw.dataimpulse.com:10000'


def audio(itag='250', extension='webm', codec='opus', **values):
    return {
        'format_id': itag, 'ext': extension, 'acodec': codec, 'vcodec': 'none',
        'protocol': 'https', 'url': 'https://fixture.googlevideo.com/videoplayback?id=' + itag,
        'abr': {'250': 70, '249': 50, '251': 160, '140': 128}.get(itag, 70),
        **values,
    }


def info(formats=None, **values):
    return {'id': VIDEO_ID, 'title': 'Synthetic fixture', 'duration': 10,
            'formats': formats if formats is not None else [audio()], **values}


class Response(io.BytesIO):
    def __init__(self, body, url):
        super().__init__(body)
        self.url = url
        self.headers = {'Content-Type': 'audio/webm'}


class FakeYoutubeDL:
    fixture = info()
    bodies = {}
    failures = {}
    instances = []

    def __init__(self, options):
        self.options = options
        self.extractions = []
        self.downloads = []
        self.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def extract_info(self, url, *, download, process):
        self.extractions.append((url, download, process))
        return copy.deepcopy(self.fixture)

    def urlopen(self, url):
        itag = url.rsplit('=', 1)[-1]
        return Response(self.bodies.get(itag, b'fixture-audio'), url)

    def dl(self, target, selected):
        self.downloads.append(copy.deepcopy(selected))
        self.assert_audio(selected)
        part = Path(target + '.part')
        itag = selected['format_id']
        with self.urlopen(selected['url']) as response, part.open('wb') as output:
            failure = self.failures.get(itag)
            if failure:
                output.write(response.read(2))
                raise RuntimeError(failure)
            while chunk := response.read(3):
                output.write(chunk)
        part.rename(target)
        return True, True

    def assert_audio(self, selected):
        if selected.get('vcodec') != 'none' or selected.get('requested_formats'):
            raise AssertionError('Video/merged format reached native downloader')


class ExtractionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.scratch = Path(self.temp.name)
        self.request = {
            'url': URL, 'max_bytes': 1000, 'max_duration_seconds': 30,
            'proxy': PROXY, 'deadline': time.monotonic() + 30,
            'scratch': self.temp.name, 'token_provider_url': 'http://127.0.0.1:4416',
            'deno_path': '/usr/bin/deno',
        }
        FakeYoutubeDL.fixture = info()
        FakeYoutubeDL.instances = []
        FakeYoutubeDL.failures = {}
        FakeYoutubeDL.bodies = {}
        self.addCleanup(self.temp.cleanup)

    def execute(self, fixture=None):
        if fixture is not None:
            FakeYoutubeDL.fixture = fixture
        return extract.execute(self.request, FakeYoutubeDL)

    def failure(self, code, fixture=None):
        with self.assertRaises(extract.ExtractionFailure) as caught:
            self.execute(fixture)
        self.assertEqual(caught.exception.code, code)

    def test_medium_native_audio_uses_one_extraction_and_no_processing(self):
        result = self.execute(info([audio('251'), audio('140', 'm4a', 'mp4a.40.2'), audio('250'), audio('249')]))
        instance = FakeYoutubeDL.instances[0]
        self.assertEqual(instance.extractions, [(URL, False, False)])
        self.assertEqual([item['format_id'] for item in instance.downloads], ['250'])
        self.assertEqual(result['filename'], 'audio.webm')
        self.assertEqual(result['content_type'], 'audio/webm')
        self.assertEqual(result['bytes_downloaded'], len(b'fixture-audio'))
        self.assertEqual(result['metadata']['bitrate_kbps'], 70)
        self.assertEqual((self.scratch / result['filename']).read_bytes(), b'fixture-audio')
        options = instance.options
        self.assertEqual(options['proxy'], PROXY)
        self.assertEqual(options['js_runtimes'], {'deno': {'path': '/usr/bin/deno'}})
        self.assertEqual(options['remote_components'], [])
        self.assertEqual(options['postprocessors'], [])
        self.assertEqual(options['fixup'], 'never')
        self.assertEqual(options['external_downloader'], {'default': 'native'})
        self.assertEqual(options['concurrent_fragment_downloads'], 1)
        self.assertEqual(options['extractor_args']['youtube']['player_client'], ['mweb'])
        self.assertEqual(options['extractor_args']['youtubepot-bgutilhttp']['base_url'], ['http://127.0.0.1:4416'])
        self.assertTrue(all(options[key] == 0 for key in ('retries', 'extractor_retries', 'fragment_retries', 'file_access_retries')))

    def test_missing_medium_uses_other_webm_then_m4a(self):
        result = self.execute(info([audio('251'), audio('140', 'm4a', 'mp4a.40.2'), audio('249')]))
        self.assertEqual(result['metadata']['format_id'], '249')
        (self.scratch / 'audio.webm').unlink()
        result = self.execute(info([audio('140', 'm4a', 'mp4a.40.2')]))
        self.assertEqual(result['filename'], 'audio.m4a')
        self.assertEqual(result['content_type'], 'audio/mp4')

    def test_unknown_webm_id_uses_native_bitrate_nearest_medium(self):
        result = self.execute(info([audio('new-high', abr=150), audio('new-medium', abr=72), audio('new-low', abr=40)]))
        self.assertEqual(result['metadata']['format_id'], 'new-medium')

    def test_original_track_wins_over_default_or_dubbed_medium(self):
        formats = [audio('250', language='fr', language_preference=5),
                   audio('251', language='ar', language_preference=10)]
        result = self.execute(info(formats))
        self.assertEqual(result['metadata']['format_id'], '251')
        self.assertEqual(result['metadata']['language'], 'ar')

    def test_original_m4a_wins_over_translated_webm(self):
        result = self.execute(info([audio('250', language='en', language_preference=5),
                                   audio('140', 'm4a', 'mp4a.40.2', language='ar', language_preference=10)]))
        self.assertEqual(result['metadata']['format_id'], '140')

    def test_oversize_original_cannot_fall_back_to_smaller_default_dub(self):
        self.failure('IMPORT_TOO_LARGE', info([
            audio('250', language='ar', language_preference=10, filesize=1001),
            audio('249', language='en', language_preference=5, filesize=13),
        ]))
        self.assertEqual(FakeYoutubeDL.instances[-1].downloads, [])

    def test_unavailable_original_cannot_fall_back_to_default_dub(self):
        self.failure('IMPORT_DEPENDENCY_FAILED', info([
            audio('250', language='ar', language_preference=10, url=None),
            audio('249', language='en', language_preference=5, filesize=13),
        ]))
        self.assertEqual(FakeYoutubeDL.instances[-1].downloads, [])

    def test_filtered_original_medium_uses_same_original_language_m4a(self):
        result = self.execute(info([
            audio('250', language='ar', language_preference=10, filesize=1001),
            audio('249', language='en', language_preference=5, filesize=13),
            audio('140', 'm4a', 'mp4a.40.2', language='ar', language_preference=10),
        ]))
        self.assertEqual(result['metadata']['format_id'], '140')
        self.assertEqual(result['metadata']['language'], 'ar')

    def test_single_unlabelled_original_track_is_allowed(self):
        result = self.execute(info([audio(language='ar', language_preference=-1)]))
        self.assertEqual(result['metadata']['language'], 'ar')

    def test_ambiguous_languages_and_explicit_dubs_are_not_downloaded(self):
        self.failure('IMPORT_UNSUPPORTED_AUDIO_SOURCE', info([audio('250', language='fr'), audio('251', language='en')]))
        self.assertEqual(FakeYoutubeDL.instances[0].downloads, [])
        for note in ('auto-dubbed', 'audio descriptive'):
            self.failure('IMPORT_UNSUPPORTED_AUDIO_SOURCE', info([audio(format_note=note)]))
        self.failure('IMPORT_DEPENDENCY_FAILED', info([audio(format_note='MISSING POT')]))

    def test_format_failure_falls_back_without_extracting_again(self):
        FakeYoutubeDL.failures = {'250': 'HTTP Error 403: fixture-secret'}
        result = self.execute(info([audio('250'), audio('249')]))
        instance = FakeYoutubeDL.instances[0]
        self.assertEqual(instance.extractions, [(URL, False, False)])
        self.assertEqual([item['format_id'] for item in instance.downloads], ['250', '249'])
        self.assertEqual(result['bytes_downloaded'], 2 + len(b'fixture-audio'))
        self.assertEqual(list(self.scratch.iterdir()), [self.scratch / 'audio.webm'])
        self.assertNotIn('fixture-secret', str(result))

    def test_partial_format_bytes_share_one_budget(self):
        self.request['max_bytes'] = 5
        FakeYoutubeDL.bodies = {'250': b'ab', '249': b'1234'}
        FakeYoutubeDL.failures = {'250': 'HTTP Error 403'}
        self.failure('IMPORT_TOO_LARGE', info([audio('250'), audio('249'), audio('140', 'm4a', 'aac')]))
        self.assertEqual([item['format_id'] for item in FakeYoutubeDL.instances[0].downloads], ['250', '249'])
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_exact_budget_succeeds_and_one_extra_byte_is_rejected(self):
        self.request['max_bytes'] = 4
        FakeYoutubeDL.bodies = {'250': b'1234'}
        self.assertEqual(self.execute()['bytes_downloaded'], 4)
        (self.scratch / 'audio.webm').unlink()
        FakeYoutubeDL.bodies = {'250': b'12345'}
        self.failure('IMPORT_TOO_LARGE')
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_known_oversize_format_falls_back_without_media_bytes(self):
        self.request['max_bytes'] = 100
        result = self.execute(info([audio('250', filesize=200), audio('249', filesize=13)]))
        self.assertEqual(result['metadata']['format_id'], '249')
        self.assertEqual(len(FakeYoutubeDL.instances[0].downloads), 1)

    def test_playlists_live_private_and_source_mismatch_rejected_before_transfer(self):
        for fixture, code in [
            (info(_type='playlist', entries=[]), 'IMPORT_SINGLE_ITEM_REQUIRED'),
            (info(is_live=True), 'IMPORT_UNSUPPORTED_AUDIO_SOURCE'),
            (info(live_status='is_upcoming'), 'IMPORT_UNSUPPORTED_AUDIO_SOURCE'),
            (info(availability='private'), 'IMPORT_SOURCE_UNAVAILABLE'),
            (info(id='other_id123'), 'IMPORT_INVALID_AUDIO'),
            (info(duration=31), 'IMPORT_TOO_LONG'),
        ]:
            self.failure(code, fixture)
            self.assertEqual(FakeYoutubeDL.instances[-1].downloads, [])

    def test_video_drm_manifest_and_unsafe_delivery_never_download(self):
        for extra, code in [
            ({'vcodec': 'avc1'}, 'IMPORT_DEPENDENCY_FAILED'),
            ({'width': 320}, 'IMPORT_UNSUPPORTED_AUDIO_SOURCE'),
            ({'has_drm': True}, 'IMPORT_UNSUPPORTED_AUDIO_SOURCE'),
            ({'protocol': 'm3u8_native'}, 'IMPORT_UNSUPPORTED_AUDIO_SOURCE'),
            ({'fragments': [{'url': 'fixture'}]}, 'IMPORT_DEPENDENCY_FAILED'),
            ({'url': 'https://127.0.0.1/videoplayback?id=250'}, 'IMPORT_UNSUPPORTED_AUDIO_SOURCE'),
            ({'url': 'https://googlevideo.com/videoplayback?id=250'}, 'IMPORT_UNSUPPORTED_AUDIO_SOURCE'),
            ({'url': 'https://fixture.googlevideo.com:443/videoplayback?id=250'}, 'IMPORT_UNSUPPORTED_AUDIO_SOURCE'),
        ]:
            self.failure(code, info([audio(**extra)]))
            self.assertEqual(FakeYoutubeDL.instances[-1].downloads, [])

    def test_raw_process_false_formats_infer_https_and_audio_bitrate_without_mutation(self):
        medium = audio('250', protocol=None, abr=None, tbr=60.478, filesize=13)
        drc = audio('250-drc', protocol=None, abr=None, tbr=63.755, format_note='medium, DRC')
        aac = audio('140', 'm4a', 'mp4a.40.2', abr=None, tbr=129.796)
        del aac['protocol']
        fixture = info([audio('18', 'mp4', 'mp4a.40.2', protocol=None, vcodec='avc1'), drc, aac, medium])
        selected = extract.eligible_formats(fixture, 1000)
        self.assertEqual([fmt['format_id'] for fmt in selected], ['250', '250-drc', '140'])
        self.assertTrue(all(fmt['protocol'] == 'https' for fmt in selected))
        self.assertEqual(selected[0]['abr'], 60.478)
        self.assertEqual(selected[-1]['abr'], 129.796)
        self.assertIsNone(medium['protocol'])
        self.assertIsNone(medium['abr'])
        self.assertNotIn('protocol', aac)
        result = self.execute(fixture)
        self.assertEqual(result['metadata']['format_id'], '250')
        self.assertEqual(result['metadata']['bitrate_kbps'], 60.478)
        self.assertEqual(FakeYoutubeDL.instances[0].downloads[0]['protocol'], 'https')

    def test_missing_protocol_never_allows_video_drm_manifest_or_unsafe_urls(self):
        for extra in [
            {'vcodec': 'avc1'}, {'has_drm': True}, {'fragments': [{'url': 'fixture'}]},
            {'manifest_url': 'https://fixture.googlevideo.com/videoplayback?id=250'},
            {'url': 'http://fixture.googlevideo.com/videoplayback?id=250'},
            {'url': 'https://127.0.0.1/videoplayback?id=250'},
        ]:
            with self.assertRaises(extract.ExtractionFailure):
                self.execute(info([audio(protocol=None, **extra)]))
            self.assertEqual(FakeYoutubeDL.instances[-1].downloads, [])

    def test_transient_empty_or_missing_native_formats_allow_bounded_service_retry(self):
        for formats in ([], [audio(vcodec='avc1')], [audio(format_note='MISSING POT')], [audio(url=None)]):
            self.failure('IMPORT_DEPENDENCY_FAILED', info(formats))
            self.assertEqual(FakeYoutubeDL.instances[-1].downloads, [])

    def test_extractor_downloader_overrides_and_extra_urls_are_discarded(self):
        fmt = audio(downloader_options={'external_downloader': 'ffmpeg', 'http_chunk_size': 999999999},
                    __postprocessors=['ffmpeg'], additional_urls=['https://fixture.invalid'])
        self.execute(info([fmt], additional_urls=['https://fixture.invalid']))
        selected = FakeYoutubeDL.instances[0].downloads[0]
        self.assertNotIn('downloader_options', selected)
        self.assertNotIn('additional_urls', selected)
        self.assertNotIn('__postprocessors', selected)
        self.assertEqual(selected['http_headers']['Accept-Encoding'], 'identity')

    def test_metadata_discards_credentials_urls_and_raw_payloads(self):
        result = self.execute(info(title='fixture-password title', channel='https://fixture.invalid',
                                   uploader='safe\u0000 uploader', raw_payload={'secret': 'fixture-password'}))
        metadata = result['metadata']
        self.assertNotIn('title', metadata)
        self.assertNotIn('channel', metadata)
        self.assertEqual(metadata['artist'], 'safe uploader')
        self.assertNotIn('raw_payload', metadata)
        self.assertNotIn('url', metadata)
        self.assertNotIn('http_headers', metadata)

    def test_metadata_checks_full_string_before_truncation(self):
        metadata = extract.clean_metadata({'title': 'x' * 195 + 'fixture-password'}, ('fixture-password',))
        self.assertNotIn('title', metadata)

    def test_bad_url_or_empty_proxy_cannot_use_direct_network(self):
        for url in ('https://www.youtube.com/playlist?list=fixture', 'ytsearch:fixture', 'https://127.0.0.1'):
            self.request['url'] = url
            self.failure('IMPORT_INVALID_URL')
        self.request['url'] = URL
        self.request['proxy'] = ''
        self.failure('IMPORT_INVALID_REQUEST')
        self.assertEqual(FakeYoutubeDL.instances, [])

    def test_expired_deadline_prevents_extraction(self):
        self.request['deadline'] = time.monotonic() - 1
        self.failure('IMPORT_DEPENDENCY_FAILED')
        self.assertEqual(FakeYoutubeDL.instances, [])

    def test_error_classification_never_returns_raw_upstream_text(self):
        failure = extract.classify(RuntimeError('HTTP Error 403 secret signed URL https://fixture.invalid'))
        self.assertEqual(str(failure), 'IMPORT_UPSTREAM_REFUSED')
        self.assertEqual(extract.classify(RuntimeError('Private video credential')).code, 'IMPORT_SOURCE_UNAVAILABLE')

    def test_child_protocol_bounds_progress_and_discards_library_output(self):
        output = io.StringIO()
        request_stream = mock.Mock(buffer=io.BytesIO(b'{}'))

        def execute(_request, progress):
            print('fixture-password raw library output')
            for _ in range(1000):
                progress({'phase': 'extraction', 'proxy': PROXY, 'reason': 'fixture-password'},
                         {'token_generation_ms': 1, 'fixture-password': 2})
            raise extract.ExtractionFailure(diagnostics={'reason': 'http_forbidden',
                                                         'http_status': 403, 'message': PROXY})

        with mock.patch.object(extract.sys, 'stdout', output), \
                mock.patch.object(extract.sys, 'stdin', request_stream), \
                mock.patch.object(extract, 'execute', side_effect=execute):
            extract.main()
        records = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(records), 65)
        self.assertEqual(records[-1]['error'], 'IMPORT_DEPENDENCY_FAILED')
        self.assertEqual(records[-1]['diagnostics']['http_status'], 403)
        self.assertNotIn('fixture-password', output.getvalue())
        self.assertNotIn(PROXY, output.getvalue())
        self.assertLess(len(output.getvalue()), 8192 + 64 * 1024)

    def test_failed_extraction_preserves_phase_reason_and_timing_without_messages(self):
        class FailedYoutubeDL(FakeYoutubeDL):
            def extract_info(self, *_args, **_kwargs):
                raise RuntimeError('HTTP Error 429 ' + PROXY + ' cookie-token-secret')

        observed = []
        with self.assertRaises(extract.ExtractionFailure) as caught:
            extract.execute(self.request, FailedYoutubeDL,
                            progress=lambda context, timings: observed.append((context, timings)))
        failure = caught.exception
        self.assertEqual(failure.diagnostics['phase'], 'extraction')
        self.assertEqual(failure.diagnostics['http_status'], 429)
        self.assertEqual(failure.diagnostics['reason'], 'http_rate_limited')
        self.assertIn('extraction_ms', failure.timings_ms)
        self.assertNotIn('fixture-password', str(failure.diagnostics))
        self.assertNotIn('cookie-token-secret', str(observed))

    def test_missing_formats_and_token_failure_are_distinguished(self):
        with self.assertRaises(extract.ExtractionFailure) as caught:
            self.execute(info([]))
        self.assertEqual(caught.exception.diagnostics['phase'], 'format_selection')
        self.assertEqual(caught.exception.diagnostics['reason'], 'no_native_audio')

        class TokenFailureYoutubeDL(FakeYoutubeDL):
            def extract_info(self, *_args, **_kwargs):
                try:
                    self.urlopen(self.options['extractor_args']['youtubepot-bgutilhttp']['base_url'][0] + '/get_pot')
                except TimeoutError:
                    pass
                return info([])

            def urlopen(self, url):
                raise TimeoutError('fixture-password signed token URL')

        with self.assertRaises(extract.ExtractionFailure) as caught:
            extract.execute(self.request, TokenFailureYoutubeDL)
        self.assertEqual(caught.exception.diagnostics['upstream_phase'], 'token_generation')
        self.assertEqual(caught.exception.diagnostics['reason'], 'network_timeout')
        self.assertTrue(caught.exception.diagnostics['timeout'])
        self.assertNotIn('fixture-password', str(caught.exception.diagnostics))

    def test_extraction_and_token_stage_timings_do_not_double_count(self):
        elapsed = 1000.0
        token_url = self.request['token_provider_url'] + '/get_pot'

        class TimedYoutubeDL(FakeYoutubeDL):
            def extract_info(self, *_args, **_kwargs):
                nonlocal elapsed
                elapsed += 2
                self.urlopen(token_url).close()
                elapsed += 2
                return info()

            def urlopen(self, url):
                nonlocal elapsed
                if url == token_url:
                    elapsed += 5
                    return Response(b'{}', url)
                return super().urlopen(url)

        self.request['deadline'] = elapsed + 30
        with mock.patch.object(extract.time, 'monotonic', side_effect=lambda: elapsed):
            result = extract.execute(self.request, TimedYoutubeDL)
        self.assertEqual(result['timings_ms']['extraction_ms'], 4000)
        self.assertEqual(result['timings_ms']['token_generation_ms'], 5000)

    def test_html_media_challenge_is_rejected_before_read_and_format_fallback(self):
        responses = []

        class ChallengeYoutubeDL(FakeYoutubeDL):
            def urlopen(self, url):
                response = super().urlopen(url)
                if url.endswith('=250'):
                    response.headers['Content-Type'] = 'text/html'
                    response.read = mock.Mock(wraps=response.read)
                    responses.append(response)
                return response

        FakeYoutubeDL.fixture = info([audio('250'), audio('249')])
        result = extract.execute(self.request, ChallengeYoutubeDL)
        self.assertEqual(result['metadata']['format_id'], '249')
        self.assertEqual(result['bytes_downloaded'], len(b'fixture-audio'))
        responses[0].read.assert_not_called()


@unittest.skipIf(InstalledYoutubeDL is None, 'Install the pinned adapter dependencies for native-runtime fixtures.')
class NativeRuntimeTest(unittest.TestCase):
    def test_real_native_downloader_fallback_uses_same_metadata_and_proxy(self):
        body = b'\x1a\x45\xdf\xa3synthetic-native-opus'
        instance = None

        class FixtureYoutubeDL(InstalledYoutubeDL):
            def __init__(self, opts):
                nonlocal instance
                super().__init__(opts)
                self.extracted = 0
                self.requests = []
                instance = self

            def extract_info(self, *_args, **_kwargs):
                self.extracted += 1
                return info([audio('250'), audio('249', filesize=len(body))])

            def urlopen(self, request):
                self.requests.append(request)
                if request.url.endswith('=250'):
                    raise HTTPError(NativeResponse(io.BytesIO(), request.url, {}, status=403))
                return NativeResponse(io.BytesIO(body), request.url,
                                      {'Content-Length': str(len(body)), 'Content-Type': 'audio/webm'})

        with tempfile.TemporaryDirectory() as scratch:
            result = extract.execute({
                'url': URL, 'proxy': PROXY, 'max_bytes': 1000,
                'max_duration_seconds': 30, 'deadline': time.monotonic() + 30,
                'scratch': scratch, 'token_provider_url': 'http://127.0.0.1:4416',
            }, FixtureYoutubeDL)
            self.assertEqual((Path(scratch) / 'audio.webm').read_bytes(), body)
        self.assertEqual(result['metadata']['format_id'], '249')
        self.assertEqual(result['bytes_downloaded'], len(body))
        self.assertEqual(instance.extracted, 1)
        self.assertEqual(len(instance.requests), 2)
        self.assertEqual(instance.params['proxy'], PROXY)
        self.assertEqual(result['content_type'], 'audio/webm')

    def test_sequential_native_ranges_keep_whole_format_byte_limit(self):
        body = b'0123456789abcdef'
        ranges = []

        class RangeYoutubeDL(InstalledYoutubeDL):
            def __init__(self, opts):
                opts['http_chunk_size'] = 5
                super().__init__(opts)

            def extract_info(self, *_args, **_kwargs):
                return info([audio(filesize=len(body))])

            def urlopen(self, request):
                span = request.headers['Range'].removeprefix('bytes=').split('-')
                start = int(span[0])
                end = min(int(span[1]) if span[1] else len(body) - 1, len(body) - 1)
                ranges.append((start, end))
                return NativeResponse(io.BytesIO(body[start:end + 1]), request.url, {
                    'Content-Length': str(end - start + 1),
                    'Content-Range': f'bytes {start}-{end}/{len(body)}',
                    'Content-Type': 'audio/webm',
                }, status=206)

        with tempfile.TemporaryDirectory() as scratch:
            result = extract.execute({
                'url': URL, 'proxy': PROXY, 'max_bytes': len(body),
                'max_duration_seconds': 30, 'deadline': time.monotonic() + 30,
                'scratch': scratch, 'token_provider_url': 'http://127.0.0.1:4416',
            }, RangeYoutubeDL)
            self.assertEqual((Path(scratch) / 'audio.webm').read_bytes(), body)
        self.assertGreater(len(ranges), 1)
        self.assertEqual(result['bytes_downloaded'], len(body))

    def test_media_guards_reject_compression_and_unsafe_redirect_before_body(self):
        import urllib.request
        from yt_dlp.networking._urllib import HTTPHandler, RedirectHandler
        with InstalledYoutubeDL(extract.options({
            'proxy': PROXY, 'max_bytes': 1000, 'token_provider_url': 'http://127.0.0.1:4416',
        })) as downloader:
            extract.secure_native_transport(downloader, 'http://127.0.0.1:4416')
            transport = downloader._request_director.handlers['Urllib']
            opener = transport._create_instance({'all': PROXY}, downloader.cookiejar)
            http = next(handler for handler in opener.handlers if isinstance(handler, HTTPHandler))
            redirect = next(handler for handler in opener.handlers if isinstance(handler, RedirectHandler))
            request = urllib.request.Request(audio()['url'])
            response = mock.Mock(headers={'Content-Encoding': 'gzip'})
            with self.assertRaises(extract.ExtractionFailure):
                http.http_response(request, response)
            response.read.assert_not_called()
            response.close.assert_called_once()
            for target in ('https://127.0.0.1/videoplayback?id=250', 'http://fixture.googlevideo.com/videoplayback?id=250'):
                with self.assertRaises(extract.ExtractionFailure):
                    redirect.redirect_request(request, mock.Mock(), 302, '', {}, target)
            next_request = redirect.redirect_request(request, mock.Mock(), 302, '', {}, audio('249')['url'])
            self.assertEqual(next_request.full_url, audio('249')['url'])


if __name__ == '__main__':
    unittest.main()
