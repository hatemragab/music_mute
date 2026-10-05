"""Offline raw-player fixtures against the immutable, pinned upstream extractor.

Run with ``python3 -I -B -S tests/test_downloader_source_identity.py``. The wheel
is read only from the ignored qualification output, or from an explicitly
selected ``MUSICMUTE_LOCAL_DOWNLOADER_TARGET``. These tests do not acquire media
or establish YouTube/player-selected source identity.
"""

from contextlib import ExitStack
import hashlib
import importlib.util
import os
from pathlib import Path
import socket
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.request
from urllib.parse import parse_qs, urlencode


COMPONENT = Path(__file__).resolve().parents[1]
SOURCE = COMPONENT / "engine/downloader_bootstrap.py"
WHEEL = Path(os.environ.get(
    "MUSICMUTE_LOCAL_DOWNLOADER_TARGET",
    COMPONENT / "output/downloader-wheel-qualification/downloader",
)).resolve() / "yt_dlp-2026.8.19-py3-none-any.whl"
WHEEL_BYTES = 3_185_533
WHEEL_SHA256 = "1d57897e94c6665a0a6f9bc54b34e584284e32c034ffab3a7df25d8f7b24eedf"
VIDEO_ID = "fixture0001"
PLAYER_URL = "https://fixture.invalid/player.js"
TRACK_ID = "musicmute_audio_track_id"
DEFAULT_FLAG = "musicmute_audio_is_default"
UNSET = object()


def archive_identity():
    information = WHEEL.stat()
    return (
        information.st_size,
        hashlib.sha256(WHEEL.read_bytes()).hexdigest(),
        information.st_mtime_ns,
        information.st_ctime_ns,
    )


def forbid_external_work(*args, **kwargs):
    raise AssertionError("offline fixture attempted network or child execution")


def fence_external_work(stack):
    for target in (
        "socket.create_connection",
        "socket.socket.connect",
        "socket.socket.connect_ex",
        "socket.socket.sendto",
        "urllib.request.urlopen",
        "subprocess.Popen",
        "subprocess.run",
    ):
        stack.enter_context(patch(target, side_effect=forbid_external_work))


def direct_stream(identifier="en.main", default=UNSET, *, media="main", url=None):
    track = {"displayName": "English"}
    if identifier is not UNSET:
        track["id"] = identifier
    if default is not UNSET:
        track["audioIsDefault"] = default
    return {
        "itag": 140,
        "url": url or (
            "https://r1.fixture.googlevideo.com/videoplayback"
            f"?id={media}&itag=140&expire=123&source=youtube"
        ),
        "audioTrack": track,
        "audioQuality": "AUDIO_QUALITY_MEDIUM",
        "mimeType": 'audio/mp4; codecs="mp4a.40.2"',
        "audioSampleRate": "44100",
        "audioChannels": 2,
        "contentLength": "1000",
        "approxDurationMs": "12000",
        "bitrate": 128_000,
    }


@unittest.skipUnless(WHEEL.is_file(), "requires explicitly prepared pinned qualification wheel")
class DownloaderSourceIdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not (sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode):
            raise AssertionError("run source identity fixtures with -I -B -S")
        cls.archive_before = archive_identity()
        if cls.archive_before[:2] != (WHEEL_BYTES, WHEEL_SHA256):
            raise AssertionError("qualification wheel does not match the immutable pin")
        with ExitStack() as stack:
            fence_external_work(stack)
            sys.path.insert(0, str(WHEEL))
            stack.callback(sys.path.remove, str(WHEEL))
            from yt_dlp import YoutubeDL
            from yt_dlp.extractor.youtube import YoutubeIE
            from yt_dlp.extractor.youtube import _video
            from yt_dlp.extractor.youtube._base import GvsPoTokenPolicy, StreamingProtocol
            from yt_dlp.extractor.youtube.jsc.provider import JsChallengeType

            cls.YoutubeDL = YoutubeDL
            cls.YoutubeIE = YoutubeIE
            cls.video_module = _video
            cls.StreamingProtocol = StreamingProtocol
            cls.GvsPoTokenPolicy = GvsPoTokenPolicy
            cls.JsChallengeType = JsChallengeType
            cls.upstream_list_formats = YoutubeIE._list_formats
            if Path(_video.__file__).parts[:len(WHEEL.parts)] != WHEEL.parts:
                raise AssertionError("upstream extractor was not imported from the pinned wheel")
            specification = importlib.util.spec_from_file_location(
                "musicmute_source_identity_bootstrap", SOURCE,
            )
            cls.bootstrap = importlib.util.module_from_spec(specification)
            specification.loader.exec_module(cls.bootstrap)

    @classmethod
    def tearDownClass(cls):
        if archive_identity() != cls.archive_before:
            raise AssertionError("pinned wheel changed during offline fixtures")

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        fence_external_work(self.stack)
        self.downloader = self.YoutubeDL(
            {"quiet": True, "no_warnings": True, "cachedir": False}, auto_init=False,
        )
        self.stack.enter_context(patch.object(
            self.downloader, "urlopen", side_effect=forbid_external_work,
        ))
        self.extractor = self.YoutubeIE(self.downloader)
        policies = {
            protocol: self.GvsPoTokenPolicy(required=False, recommended=False)
            for protocol in self.StreamingProtocol
        }
        self.stack.enter_context(patch.object(
            self.extractor, "_get_default_ytcfg",
            return_value={"GVS_PO_TOKEN_POLICY": policies},
        ))
        self.format_types = []
        self.stack.enter_context(patch.object(
            self.extractor, "_configuration_arg",
            side_effect=lambda name, *args, **kwargs: self.format_types if name == "formats" else [],
        ))
        self.delegate_results = []
        self.delegate_formats = []

        def delegate(instance, *args, **kwargs):
            result = type(self).upstream_list_formats(instance, *args, **kwargs)
            self.delegate_results.append(result)
            self.delegate_formats.append([dict(fmt) for fmt in result[2]])
            return result

        self.stack.enter_context(patch.object(self.YoutubeIE, "_list_formats", delegate))
        self.stack.enter_context(patch.object(
            self.YoutubeIE, "_musicmute_track_identity_installed", False, create=True,
        ))
        self.bootstrap.install_audio_track_identity()

    def player_response(self, streams, *, token=None, **manifest_fields):
        module = self.video_module
        return {
            "streamingData": {
                "adaptiveFormats": streams,
                module.STREAMING_DATA_CLIENT_NAME: "fixture",
                module.STREAMING_DATA_FETCH_GVS_PO_TOKEN: lambda **kwargs: token,
                module.STREAMING_DATA_IS_PREMIUM_SUBSCRIBER: False,
                module.STREAMING_DATA_PLAYER_TOKEN_PROVIDED: False,
                module.STREAMING_DATA_AVAILABLE_AT_TIMESTAMP: 0,
                **manifest_fields,
            },
        }

    def list_formats(self, player_responses):
        previous_calls = len(self.delegate_results)
        result = self.extractor._list_formats(
            VIDEO_ID, [], [{"isLive": False, "isLiveContent": False}],
            player_responses, PLAYER_URL, 12,
        )
        self.assertEqual(len(self.delegate_results), previous_calls + 1)
        self.assertIs(result, self.delegate_results[-1])
        self.assertEqual(result[0:2], ([], "not_live"))
        self.assertEqual(result[3], {})
        # Enrichment may only add the two optional scalars. Upstream transfer,
        # ranking, fragments and format identifiers remain intact.
        for fmt, upstream in zip(result[2], self.delegate_formats[-1]):
            self.assertEqual(
                {key: value for key, value in fmt.items() if key not in (TRACK_ID, DEFAULT_FLAG)},
                upstream,
            )
        self.assertEqual(archive_identity(), self.archive_before)
        return result[2]

    def assert_unknown(self, formats):
        self.assertTrue(formats)
        for fmt in formats:
            self.assertNotIn(TRACK_ID, fmt)
            self.assertNotIn(DEFAULT_FLAG, fmt)

    def install_deterministic_solver(self):
        cache = {}
        self.solve_requests = []

        def solve(requests):
            for request in requests:
                self.solve_requests.append(request)
                results = {
                    challenge: (
                        "fixture-n-solved" if request.type == self.JsChallengeType.N
                        else challenge[::-1]
                    )
                    for challenge in request.input.challenges
                }
                yield request, SimpleNamespace(
                    type=request.type, output=SimpleNamespace(results=results),
                )

        def load(namespace, player_url, key, **kwargs):
            return cache.get((namespace, key))

        def store(value, namespace, player_url, key, **kwargs):
            cache[(namespace, key)] = value

        self.stack.enter_context(patch.object(
            self.extractor, "_jsc_director", SimpleNamespace(bulk_solve=solve), create=True,
        ))
        self.stack.enter_context(patch.object(self.extractor, "_load_player_data_from_cache", load))
        self.stack.enter_context(patch.object(self.extractor, "_store_player_data_to_cache", store))

    def test_same_language_preserves_distinct_full_ids_and_false_default(self):
        formats = self.list_formats([self.player_response([
            direct_stream("en.main-1", False, media="main"),
            direct_stream("en.dub-2", False, media="dub"),
        ])])
        self.assertEqual([fmt["language"] for fmt in formats], ["en", "en"])
        self.assertEqual([fmt[TRACK_ID] for fmt in formats], ["en.main-1", "en.dub-2"])
        self.assertEqual([fmt[DEFAULT_FLAG] for fmt in formats], [False, False])

    def test_missing_track_id_and_missing_default_remain_independently_unknown(self):
        formats = self.list_formats([self.player_response([
            direct_stream(UNSET, True, media="missing-id"),
            direct_stream("en.flag-absent", media="missing-flag"),
            direct_stream(UNSET, media="both-absent"),
        ])])
        self.assertNotIn(TRACK_ID, formats[0])
        self.assertIs(formats[0][DEFAULT_FLAG], True)
        self.assertEqual(formats[1][TRACK_ID], "en.flag-absent")
        self.assertNotIn(DEFAULT_FLAG, formats[1])
        self.assertNotIn(TRACK_ID, formats[2])
        self.assertNotIn(DEFAULT_FLAG, formats[2])

    def test_display_label_does_not_create_original_or_default_evidence(self):
        stream = direct_stream("en.labeled")
        stream["audioTrack"]["displayName"] = "English original"
        formats = self.list_formats([self.player_response([stream])])
        self.assertEqual(formats[0]["language_preference"], 10)
        self.assertEqual(formats[0][TRACK_ID], "en.labeled")
        self.assertNotIn(DEFAULT_FLAG, formats[0])
        self.assertFalse(any("original" in key for key in formats[0]))

    def test_nonboolean_raw_default_is_not_upgraded_from_upstream_preference(self):
        formats = self.list_formats([self.player_response([
            direct_stream("en.nonboolean", "false"),
        ])])
        self.assertEqual(formats[0]["language_preference"], 5)
        self.assertEqual(formats[0][TRACK_ID], "en.nonboolean")
        self.assertNotIn(DEFAULT_FLAG, formats[0])

    def test_track_id_is_bounded_without_truncation(self):
        identifier = "en." + "a" * 125
        formats = self.list_formats([self.player_response([
            direct_stream(identifier, False, media="bounded"),
            direct_stream(identifier + "b", False, media="oversized"),
        ])])
        self.assertEqual(formats[0][TRACK_ID], identifier)
        self.assertNotIn(TRACK_ID, formats[1])
        self.assertIs(formats[1][DEFAULT_FLAG], False)

    def test_conflicting_clients_with_identical_transfer_url_are_unknown(self):
        first = direct_stream("en.first", True)
        second = direct_stream("en.second", False, url=first["url"])
        formats = self.list_formats([
            self.player_response([first]), self.player_response([second]),
        ])
        self.assertEqual(len(formats), 2)
        self.assert_unknown(formats)

    def test_conflicting_default_flags_preserve_only_consensus_track_id(self):
        first = direct_stream("en.same", True)
        second = direct_stream("en.same", False, url=first["url"])
        formats = self.list_formats([
            self.player_response([first]), self.player_response([second]),
        ])
        # This pin compares the whole raw audioTrack dictionary while deduping;
        # different default flags therefore remain two upstream formats.
        self.assertEqual(len(formats), 2)
        for fmt in formats:
            self.assertEqual(fmt[TRACK_ID], "en.same")
            self.assertNotIn(DEFAULT_FLAG, fmt)

    def test_missing_client_id_does_not_upgrade_known_id_evidence(self):
        first = direct_stream("en.known", True)
        second = direct_stream(UNSET, True, url=first["url"])
        formats = self.list_formats([
            self.player_response([first]), self.player_response([second]),
        ])
        self.assertEqual(len(formats), 2)
        self.assert_unknown(formats)

    def test_identical_client_evidence_is_not_ambiguous(self):
        stream = direct_stream("en.same", False)
        formats = self.list_formats([
            self.player_response([stream]), self.player_response([dict(stream)]),
        ])
        self.assertEqual(len(formats), 1)
        self.assertEqual(formats[0][TRACK_ID], "en.same")
        self.assertIs(formats[0][DEFAULT_FLAG], False)

    def test_oversized_raw_player_response_set_is_unknown(self):
        response = self.player_response([direct_stream("en.bounded", True)])
        formats = self.list_formats([response] * 65)
        self.assertEqual(len(formats), 1)
        self.assert_unknown(formats)

    def test_n_pot_and_custom_signature_transformations_keep_raw_identity(self):
        self.install_deterministic_solver()
        stream = direct_stream("en.signed", False)
        raw_url = stream.pop("url") + "&n=fixture-n&untouched=keep%2Fthis"
        stream["signatureCipher"] = urlencode({"url": raw_url, "s": "abcd", "sp": "sig"})
        formats = self.list_formats([self.player_response([stream], token="fixture-pot")])
        self.assertEqual(len(formats), 1)
        query = parse_qs(formats[0]["url"].split("?", 1)[1])
        self.assertEqual(query["n"], ["fixture-n-solved"])
        self.assertEqual(query["pot"], ["fixture-pot"])
        self.assertEqual(query["sig"], ["dcba"])
        self.assertEqual(query["untouched"], ["keep/this"])
        self.assertEqual({request.type for request in self.solve_requests}, {
            self.JsChallengeType.N, self.JsChallengeType.SIG,
        })
        self.assertEqual(formats[0][TRACK_ID], "en.signed")
        self.assertIs(formats[0][DEFAULT_FLAG], False)

    def test_default_signature_key_is_supported(self):
        self.install_deterministic_solver()
        stream = direct_stream("en.signature", True)
        stream["signatureCipher"] = urlencode({"url": stream.pop("url"), "s": "abcd"})
        formats = self.list_formats([self.player_response([stream])])
        self.assertIn("signature=dcba", formats[0]["url"])
        self.assertEqual(formats[0][TRACK_ID], "en.signature")
        self.assertIs(formats[0][DEFAULT_FLAG], True)

    def test_derived_dash_keeps_direct_transfer_identity(self):
        self.format_types = ["duplicate"]
        stream = direct_stream("en.dashy", False)
        formats = self.list_formats([self.player_response([stream])])
        self.assertEqual(len(formats), 2)
        self.assertEqual(formats[0]["protocol"], "http_dash_segments")
        self.assertNotIn("protocol", formats[1])
        self.assertEqual([fmt["url"] for fmt in formats], [stream["url"], stream["url"]])
        self.assertEqual([fmt[TRACK_ID] for fmt in formats], ["en.dashy", "en.dashy"])
        self.assertEqual([fmt[DEFAULT_FLAG] for fmt in formats], [False, False])

    def test_manifest_language_and_itag_do_not_create_full_track_identity(self):
        manifest_format = {
            "format_id": "140", "language": "en", "vcodec": "none", "acodec": "mp4a.40.2",
            "protocol": "http_dash_segments", "url": (
                "https://r1.fixture.googlevideo.com/manifest/itag/140/clen/1000"
            ),
        }
        parser = self.stack.enter_context(patch.object(
            self.extractor, "_extract_mpd_formats_and_subtitles",
            return_value=([manifest_format], {}),
        ))
        stream = direct_stream("en.direct", True)
        formats = self.list_formats([self.player_response(
            [stream], dashManifestUrl="https://fixture.invalid/manifest.mpd",
        )])
        parser.assert_called_once()
        self.assertEqual(formats[0][TRACK_ID], "en.direct")
        self.assertEqual(formats[1]["language_preference"], 5)
        self.assert_unknown(formats[1:])

    def test_nontransformed_query_fields_cannot_be_ignored_for_matching(self):
        stream = direct_stream("en.exact", True)
        formats = self.list_formats([self.player_response([stream])])
        # Exercise a returned transfer mismatch after genuine upstream extraction.
        changed = dict(formats[0])
        changed.pop(TRACK_ID)
        changed.pop(DEFAULT_FLAG)
        changed["url"] = changed["url"].replace("expire=123", "expire=124")
        self.bootstrap.enrich_audio_tracks([changed], [self.player_response([stream])])
        self.assert_unknown([changed])

    def test_malformed_and_oversized_raw_metadata_remain_unknown(self):
        stream = direct_stream("en.helper", True)
        original = self.list_formats([self.player_response([stream])])[0]
        format_without_identity = {
            key: value for key, value in original.items() if key not in (TRACK_ID, DEFAULT_FLAG)
        }
        malformed_url = stream["url"].replace(".com/", ".com:invalid/")
        signed_url = stream["url"] + "&signature=already-present"
        signed_stream = {key: value for key, value in stream.items() if key != "url"}
        signed_stream["signatureCipher"] = urlencode({"url": signed_url, "s": "abcd"})
        signature_groups = []
        for index in range(33):
            candidate = {key: value for key, value in stream.items() if key != "url"}
            candidate["signatureCipher"] = urlencode({
                "url": stream["url"], "s": "abcd", "sp": f"sig{index}",
            })
            signature_groups.append(candidate)
        cases = (
            ("malformed_port", [self.player_response([{**stream, "url": malformed_url}])],
             [{**format_without_identity, "url": malformed_url}]),
            ("preexisting_signature", [self.player_response([signed_stream])],
             [{**format_without_identity, "url": signed_url + "&signature=dcba"}]),
            ("stream_bound", [self.player_response([stream] * 4097)], [dict(format_without_identity)]),
            ("format_bound", [self.player_response([stream])],
             [dict(format_without_identity) for _ in range(2049)]),
            ("signature_group_bound", [self.player_response(signature_groups)], [dict(format_without_identity)]),
            ("malformed_stream_list", [self.player_response({"unexpected": "mapping"})],
             [dict(format_without_identity)]),
        )
        for name, responses, formats in cases:
            with self.subTest(case=name):
                self.bootstrap.enrich_audio_tracks(formats, responses)
                self.assert_unknown(formats)

    def test_installer_is_idempotent_and_delegates_once(self):
        installed = self.YoutubeIE._list_formats
        self.bootstrap.install_audio_track_identity()
        self.assertIs(self.YoutubeIE._list_formats, installed)
        formats = self.list_formats([self.player_response([direct_stream("en.once", False)])])
        self.assertEqual(len(self.delegate_results), 1)
        self.assertEqual(formats[0][TRACK_ID], "en.once")


if __name__ == "__main__":
    unittest.main()
