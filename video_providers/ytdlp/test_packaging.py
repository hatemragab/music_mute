"""Local package/startup invariants; no proxy, provider or media requests."""
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

import bootstrap
import patch_provider
from package_caprover import FILES, package, source_path


class RuntimeTests(unittest.TestCase):
    def test_changed_upstream_patch_source_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'does not match'):
            patch_provider.patch('unqualified token provider source')

    def test_provider_only_loopback_deno_and_bundled_cache(self):
        command = bootstrap.provider_command()
        self.assertEqual(command[0], '/usr/bin/deno')
        self.assertIn('--cached-only', command)
        self.assertIn('--frozen', command)
        self.assertEqual(command[-4:], ['--host', '127.0.0.1', '--port', '4416'])
        with patch.dict('os.environ', {'DATAIMPULSE_RESIDENTIAL_PASSWORD': 'private',
                                      'AUDIO_ACQUISITION_API_KEY': 'private'}, clear=True):
            environment = bootstrap.provider_environment()
        self.assertEqual(environment['DENO_DIR'], '/app/.cache/deno')
        self.assertNotIn('private', environment.values())
        self.assertFalse(any('DATAIMPULSE' in key or 'API_KEY' in key for key in environment))

    def test_missing_or_mismatched_dependency_fails_closed(self):
        with patch('bootstrap.importlib.metadata.version', return_value='wrong'):
            with self.assertRaisesRegex(SystemExit, 'Missing matching acquisition runtime'):
                bootstrap.validate_runtime()
        with patch('bootstrap.importlib.metadata.version', side_effect=bootstrap.PINNED.get), \
                patch('bootstrap.subprocess.run', return_value=Mock(stdout='deno 2.8.0\nv8 1\n')):
            with self.assertRaises(SystemExit):
                bootstrap.validate_runtime()

    def test_pinned_components_validated_without_network(self):
        with patch('bootstrap.importlib.metadata.version', side_effect=bootstrap.PINNED.get), \
                patch('bootstrap.bundled_ejs_present', return_value=True), \
                patch('bootstrap.subprocess.run', return_value=Mock(stdout='deno 2.9.5\nv8 1\n')) as run, \
                patch('bootstrap.Path.exists', return_value=True):
            bootstrap.validate_runtime()
        self.assertEqual(run.call_args.args[0], ['/usr/bin/deno', '--version'])
        self.assertEqual(run.call_args.kwargs['timeout'], 3)

    def test_deno_release_details_do_not_reject_matching_pinned_binary(self):
        for output in ('deno 2.9.5 (stable, release, x86_64-unknown-linux-gnu)\nv8 1\n',
                       'deno 2.9.5 (stable, release, aarch64-apple-darwin)\nv8 1\n'):
            with self.subTest(output=output), \
                    patch('bootstrap.importlib.metadata.version', side_effect=bootstrap.PINNED.get), \
                    patch('bootstrap.bundled_ejs_present', return_value=True), \
                    patch('bootstrap.subprocess.run', return_value=Mock(stdout=output)), \
                    patch('bootstrap.Path.exists', return_value=True):
                bootstrap.validate_runtime()

    def test_deno_version_prefix_is_not_a_matching_release(self):
        for output in ('deno 2.9.50 (stable, release, linux)\n', 'deno 2.9.7\n', ''):
            with self.subTest(output=output), \
                    patch('bootstrap.importlib.metadata.version', side_effect=bootstrap.PINNED.get), \
                    patch('bootstrap.bundled_ejs_present', return_value=True), \
                    patch('bootstrap.subprocess.run', return_value=Mock(stdout=output)), \
                    patch('bootstrap.Path.exists', return_value=True), self.assertRaises(SystemExit):
                bootstrap.validate_runtime()

    def test_missing_or_empty_ejs_solver_data_fails_closed(self):
        with tempfile.TemporaryDirectory() as scratch:
            solver = Path(scratch)
            with patch('bootstrap.importlib.resources.files', return_value=solver):
                self.assertFalse(bootstrap.bundled_ejs_present())
                for name in ('core.min.js', 'lib.min.js'):
                    (solver / name).write_bytes(b'')
                self.assertFalse(bootstrap.bundled_ejs_present())
                for name in ('core.min.js', 'lib.min.js'):
                    (solver / name).write_bytes(b'x' * 1001)
                self.assertTrue(bootstrap.bundled_ejs_present())

    def test_provider_ping_checks_version_and_disables_environment_proxy(self):
        response = Mock(status=200)
        response.read.return_value = b'{"version":"2.0.1"}'
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        opener = Mock()
        opener.open.return_value = response
        with patch('bootstrap.urllib.request.build_opener', return_value=opener) as build:
            self.assertTrue(bootstrap.provider_ready())
        self.assertEqual(build.call_args.args[0].proxies, {})
        response.read.return_value = b'{"version":"wrong"}'
        with patch('bootstrap.urllib.request.build_opener', return_value=opener):
            self.assertFalse(bootstrap.provider_ready())

    def test_children_groups_terminated_and_reaped(self):
        first = Mock(pid=101)
        second = Mock(pid=102)
        first.wait.side_effect = [subprocess.TimeoutExpired('synthetic', 3), 0]
        with patch('bootstrap.os.killpg') as kill:
            bootstrap.terminate_children([first, second])
        self.assertEqual(kill.call_count, 4)
        self.assertEqual(first.wait.call_count, 2)
        self.assertEqual(second.wait.call_count, 2)


class PackageTests(unittest.TestCase):
    def test_archive_exact_allowlist_and_source_bytes(self):
        with tempfile.TemporaryDirectory() as scratch:
            output = Path(scratch) / 'adapter.tar'
            package(output)
            with tarfile.open(output) as archive:
                self.assertEqual(tuple(archive.getnames()), FILES)
                for member in archive.getmembers():
                    self.assertTrue(member.isfile())
                    self.assertEqual(archive.extractfile(member).read(), source_path(member.name).read_bytes())
        for name in FILES:
            self.assertFalse(name.startswith('.env') or 'config' in name or 'test_' in name)

    def test_sources_must_be_regular_files(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            file = root / 'regular'
            file.write_text('synthetic')
            link = root / 'link'
            link.symlink_to(file)
            with patch('package_caprover.source_path', return_value=link):
                with self.assertRaisesRegex(ValueError, 'ordinary files'):
                    package(root / 'adapter.tar')

    def test_container_private_capacity_and_scratch_bounds(self):
        root = Path(__file__).resolve().parent
        settings = json.loads((root / 'config.example.json').read_text())
        self.assertTrue(settings['notExposedAsWebApp'])
        self.assertEqual(settings['instanceCount'], 1)
        self.assertEqual(settings['ports'], [])
        self.assertEqual(settings['volumes'], [])
        self.assertEqual(settings['environment']['ACQUISITION_CONCURRENCY'], '10')
        self.assertEqual(settings['environment']['ACQUISITION_REQUESTS_PER_SECOND'], '2')
        spec = json.loads((root / 'caprover-override.json').read_text())['TaskTemplate']['ContainerSpec']
        self.assertTrue(spec['ReadOnly'])
        self.assertTrue(spec['Init'])
        self.assertEqual(spec['Mounts'][0]['Target'], '/work')
        self.assertEqual(spec['Mounts'][0]['TmpfsOptions']['SizeBytes'], 2147483648)


if __name__ == '__main__':
    unittest.main()
