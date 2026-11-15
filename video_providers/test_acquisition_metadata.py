import base64
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent / 'router'))

from acquisition_metadata import clean_metadata, clean_thumbnail_url


VIDEO_ID = 'fixture_123'
THUMBNAIL = f'https://i.ytimg.com/vi/{VIDEO_ID}/hqdefault.jpg'


def encoded_metadata(**values):
    return base64.b64encode(json.dumps({'schema_version': 1, **values}).encode()).decode()


class ThumbnailMetadataTests(unittest.TestCase):
    def test_original_public_thumbnail_urls_are_preserved(self):
        for url in [THUMBNAIL,
                    f'https://i.ytimg.com/vi_webp/{VIDEO_ID}/maxresdefault.webp',
                    THUMBNAIL + '?sqp=-oaymwE_1-2%3D%3D&rs=AOn4CLA_fixture-123']:
            with self.subTest(url=url):
                self.assertEqual(clean_thumbnail_url(url, video_id=VIDEO_ID), url)

    def test_missing_and_non_string_thumbnails_are_omitted(self):
        for value in [None, '', 1, {}, []]:
            with self.subTest(value=value):
                self.assertIsNone(clean_thumbnail_url(value))

    def test_unsafe_urls_are_rejected(self):
        for url in [THUMBNAIL.replace('https:', 'http:'),
                    THUMBNAIL.replace('i.ytimg.com', 'i.ytimg.com.evil.invalid'),
                    THUMBNAIL.replace('i.ytimg.com', '127.0.0.1'),
                    THUMBNAIL.replace('i.ytimg.com', 'fixture.googlevideo.com'),
                    THUMBNAIL.replace('i.ytimg.com', 'user:password@i.ytimg.com'),
                    THUMBNAIL.replace('i.ytimg.com', 'i.ytimg.com:443'),
                    THUMBNAIL + '#fragment', THUMBNAIL + '#',
                    ' ' + THUMBNAIL, THUMBNAIL + '\n', THUMBNAIL + '\x7f',
                    THUMBNAIL.replace('/vi/', '/vi/../vi/'),
                    THUMBNAIL.replace('/vi/', '\\vi/'),
                    THUMBNAIL.replace('/hqdefault.jpg', '/hqdefault.svg'),
                    THUMBNAIL.replace('/hqdefault.jpg', '/%68qdefault.jpg'),
                    THUMBNAIL.replace('/hqdefault.jpg', '/..jpg'),
                    THUMBNAIL.replace('/hqdefault.jpg', '/' + 'x' * 65 + '.jpg'),
                    THUMBNAIL.replace(VIDEO_ID, 'too-short'),
                    THUMBNAIL + '?token=fixture-secret',
                    THUMBNAIL + '?url=https%3A%2F%2Fevil.invalid',
                    THUMBNAIL + '?sqp=', THUMBNAIL + '?sqp=one&sqp=two',
                    THUMBNAIL + '?sqp=one&rs=two&sqp=three',
                    THUMBNAIL + '?rs=' + 'x' * 1025,
                    THUMBNAIL + '?sqp=one%0A', THUMBNAIL + '?sqp=one+two',
                    THUMBNAIL + '?sqp=one%2Ftwo', THUMBNAIL + '?sqp=one;rs=two',
                    THUMBNAIL + '?sqp=one&', THUMBNAIL + '?rs=' + 'x' * 2048]:
            with self.subTest(url=url):
                self.assertIsNone(clean_thumbnail_url(url))

    def test_thumbnail_source_id_must_match_when_supplied(self):
        self.assertIsNone(clean_thumbnail_url(THUMBNAIL, video_id='another_123'))
        self.assertEqual(clean_thumbnail_url(THUMBNAIL, video_id=VIDEO_ID), THUMBNAIL)

    def test_secret_bearing_thumbnail_is_rejected_without_truncation(self):
        for url in [THUMBNAIL + '?rs=fixture-secret',
                    THUMBNAIL + '?rs=fixture%2Dsecret']:
            with self.subTest(url=url):
                self.assertIsNone(clean_thumbnail_url(url, ('fixture-secret',)))
        self.assertEqual(clean_thumbnail_url(THUMBNAIL, ('',)), THUMBNAIL)

    def test_header_round_trip_preserves_thumbnail_and_audio_metadata(self):
        encoded = encoded_metadata(provider='yt-dlp', title='Synthetic fixture',
                                   audio_codec='opus', duration_seconds=19,
                                   thumbnail_url=THUMBNAIL,
                                   delivery_url='https://never-forward.invalid/signed')
        clean = clean_metadata(encoded, ())
        self.assertLessEqual(len(clean), 4096)
        self.assertEqual(json.loads(base64.b64decode(clean)), {
            'schema_version': 1, 'provider': 'yt-dlp', 'title': 'Synthetic fixture',
            'audio_codec': 'opus', 'duration_seconds': 19, 'thumbnail_url': THUMBNAIL,
        })

    def test_invalid_or_secret_thumbnail_does_not_discard_descriptive_metadata(self):
        for url in ['https://never-forward.invalid/signed',
                    THUMBNAIL + '?rs=fixture-secret', None]:
            with self.subTest(url=url):
                encoded = encoded_metadata(title='Synthetic fixture', audio_codec='opus',
                                           thumbnail_url=url, channel='fixture-secret')
                clean = clean_metadata(encoded, ('fixture-secret',))
                self.assertEqual(json.loads(base64.b64decode(clean)), {
                    'schema_version': 1, 'title': 'Synthetic fixture', 'audio_codec': 'opus',
                })

    def test_thumbnail_only_header_is_kept_if_valid(self):
        clean = clean_metadata(encoded_metadata(thumbnail_url=THUMBNAIL), ())
        self.assertEqual(json.loads(base64.b64decode(clean)), {
            'schema_version': 1, 'thumbnail_url': THUMBNAIL,
        })
        self.assertIsNone(clean_metadata(encoded_metadata(thumbnail_url='http://evil.invalid'), ()))


if __name__ == '__main__':
    unittest.main()
