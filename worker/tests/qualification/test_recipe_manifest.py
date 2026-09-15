import copy
import json
import tempfile
import unittest
from pathlib import Path

from qualification import (
    ApprovedEvidenceRecord,
    evidence_sha256,
    load_candidates,
    validate_qualification,
    validate_runtime_report,
)


ROOT = Path(__file__).resolve().parents[3]
MANIFEST = ROOT / "worker" / "qualification" / "candidates.json"


class CandidateManifestTests(unittest.TestCase):
    def test_manifest_covers_every_required_os_gpu_family(self):
        manifest = load_candidates(MANIFEST)
        families = {
            (candidate["os"], candidate["arch"], candidate["gpuVendor"], candidate["provider"])
            for candidate in manifest["candidates"]
        }
        required = {
            ("windows", "x64", "amd", "DmlExecutionProvider"),
            ("windows", "x64", "intel", "DmlExecutionProvider"),
            ("windows", "x64", "nvidia", "DmlExecutionProvider"),
            ("windows", "x64", "nvidia", "CUDAExecutionProvider"),
            ("macos", "arm64", "apple", "CoreMLExecutionProvider"),
            ("macos", "x64", "intel", "CoreMLExecutionProvider"),
            ("linux", "x64", "nvidia", "CUDAExecutionProvider"),
            ("linux", "x64", "amd", "MIGraphXExecutionProvider"),
            ("linux", "x64", "intel", "OpenVINOExecutionProvider"),
            ("linux", "arm64", "arm", "ArmNNExecutionProvider"),
            ("windows", "arm64", "qualcomm", "DmlExecutionProvider"),
            ("linux", "arm64", "nvidia", "CUDAExecutionProvider"),
        }
        self.assertTrue(required.issubset(families))

    def test_no_candidate_is_qualified_without_native_evidence(self):
        manifest = load_candidates(MANIFEST)
        self.assertTrue(manifest["candidates"])
        for candidate in manifest["candidates"]:
            with self.subTest(profile=candidate["profileId"]):
                self.assertIn(candidate["status"], {"candidate", "rejected", "unavailable"})
                self.assertTrue(candidate["statusReason"])
                self.assertRegex(candidate["runtimeLockSha256"], r"^(unknown|[0-9a-f]{64})$")
                self.assertRegex(candidate["modelSha256"], r"^(unknown|[0-9a-f]{64})$")
                self.assertRegex(candidate["fixtureSha256"], r"^(unknown|[0-9a-f]{64})$")

    def test_rejects_duplicate_profile_ids(self):
        raw = json.loads(MANIFEST.read_text(encoding="utf-8"))
        raw["candidates"].append(copy.deepcopy(raw["candidates"][0]))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "candidates.json"
            path.write_text(json.dumps(raw), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate profileId"):
                load_candidates(path)

    def test_rejects_unknown_schema_fields_and_unpinned_qualified_dependencies(self):
        raw = json.loads(MANIFEST.read_text(encoding="utf-8"))
        mutations = (
            lambda value: value.update(schemaVersion=2),
            lambda value: value.update(schemaVersion=True),
            lambda value: value.update(extra=True),
            lambda value: value["candidates"][0].update(os="solaris"),
            lambda value: value["candidates"][0].update(profileId="BAD PROFILE"),
        )
        for mutate in mutations:
            value = copy.deepcopy(raw)
            mutate(value)
            with self.subTest(value=value):
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "manifest.json"
                    path.write_text(json.dumps(value), encoding="utf-8")
                    with self.assertRaises(ValueError):
                        load_candidates(path)


class QualificationAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.profile = load_candidates(MANIFEST)["candidates"][0]
        self.report = {
            "profileId": self.profile["profileId"],
            "modelSha256": "a" * 64,
            "fixtureSha256": "b" * 64,
            "runtimeLockSha256": "c" * 64,
            "acceleratorUsed": True,
            "provider": self.profile["provider"],
            "deviceLabel": "synthetic-device-label",
            "coldWallMilliseconds": 1600,
            "warmWallMilliseconds": 1200,
            "peakRamBytes": 1024,
            "peakGpuMemoryBytes": 1024,
            "outputValid": True,
            "outputFinite": True,
            "referenceCheckPassed": True,
            "referenceMetrics": {"maxAbs": 0.01, "rms": 0.001},
            "executionEvidence": {"method": "onnxruntime-profile", "acceleratedNodeCount": 10, "neuralNodeCount": 10},
            "cancellationPassed": True,
            "longClipPassed": True,
            "serviceContextPassed": True,
            "reasonCodes": [],
        }
        self.admissible = copy.deepcopy(self.profile)
        self.admissible.update(
            status="qualified",
            modelSha256="a" * 64,
            fixtureSha256="b" * 64,
            runtimeLockSha256="c" * 64,
            qualificationPolicy={
                "maxWallMilliseconds": 5000,
                "maxPeakRamBytes": 4096,
                "maxPeakGpuMemoryBytes": 4096,
                "gpuMemoryRequired": True,
                "referenceMaxAbs": 0.02,
                "referenceRms": 0.002,
                "maxMediaSeconds": 1800,
                "executionEvidenceMethod": "onnxruntime-profile",
                "serviceContextRequired": True,
            },
        )

        self.admissible["dependencies"] = {
            "python": "3.11.9",
            "audio-separator": "0.47.0",
            "onnxruntime-directml": "1.24.4",
            "numpy": "2.5.3",
            "soundfile": "0.14.0",
        }
        self.approval = ApprovedEvidenceRecord(
            profile_id=self.admissible["profileId"],
            evidence_sha256=evidence_sha256(self.report),
            approval_id="v01-native-evidence-001",
        )

    def assert_rejected(self, reason, mutate):
        report = copy.deepcopy(self.report)
        mutate(report)
        approval = ApprovedEvidenceRecord(
            profile_id=self.admissible["profileId"],
            evidence_sha256=evidence_sha256(report),
            approval_id="v01-native-evidence-001",
        )
        decision = validate_qualification(self.admissible, report, approval)
        self.assertFalse(decision.admitted)
        self.assertIn(reason, decision.reason_codes)

    def test_accepts_complete_bound_qualification_evidence(self):
        decision = validate_qualification(self.admissible, self.report, self.approval)
        self.assertTrue(decision.admitted)
        self.assertEqual(decision.reason_codes, ())

    def test_manifest_candidate_status_is_fail_closed(self):
        decision = validate_qualification(self.profile, self.report, self.approval)
        self.assertFalse(decision.admitted)
        self.assertEqual(decision.reason_codes, ("RECIPE_NOT_QUALIFIED",))

    def test_gpu_listed_but_neural_graph_on_cpu_is_rejected(self):
        self.assert_rejected(
            "CPU_ONLY_UNSUPPORTED",
            lambda report: report["executionEvidence"].update(acceleratedNodeCount=0),
        )

    def test_partial_neural_graph_execution_is_rejected(self):
        self.assert_rejected(
            "GPU_QUALIFICATION_FAILED",
            lambda report: report["executionEvidence"].update(acceleratedNodeCount=9),
        )

    def test_digest_or_provider_mismatch_is_rejected(self):
        self.assert_rejected("MODEL_INTEGRITY_FAILED", lambda report: report.update(modelSha256="d" * 64))
        self.assert_rejected("GPU_PROVIDER_UNAVAILABLE", lambda report: report.update(provider="CPUExecutionProvider"))
        self.assert_rejected("DEPENDENCY_RECIPE_UNAVAILABLE", lambda report: report.update(runtimeLockSha256="d" * 64))

    def test_invalid_nonfinite_or_reference_failure_is_rejected(self):
        self.assert_rejected("GPU_QUALIFICATION_FAILED", lambda report: report.update(outputValid=False))
        self.assert_rejected("GPU_QUALIFICATION_FAILED", lambda report: report.update(outputFinite=False))
        self.assert_rejected("GPU_QUALIFICATION_FAILED", lambda report: report.update(referenceCheckPassed=False))

    def test_missing_resource_cancellation_or_long_clip_evidence_is_rejected(self):
        self.assert_rejected("INSUFFICIENT_MEMORY", lambda report: report.update(peakRamBytes=None))
        self.assert_rejected("GPU_QUALIFICATION_FAILED", lambda report: report.update(cancellationPassed=False))
        self.assert_rejected("GPU_QUALIFICATION_FAILED", lambda report: report.update(longClipPassed=False))

    def test_rejects_missing_or_fabricated_approval(self):
        self.assertFalse(validate_qualification(self.admissible, self.report, None).admitted)
        fake = ApprovedEvidenceRecord(self.admissible["profileId"], "f" * 64, "v01-native-evidence-001")
        self.assertFalse(validate_qualification(self.admissible, self.report, fake).admitted)

    def test_rejects_unpinned_dependency_or_empty_evidence_policy(self):
        for dependency in ("latest", "9.x", "source-build-required"):
            profile = copy.deepcopy(self.admissible)
            profile["dependencies"]["onnxruntime-directml"] = dependency
            self.assertFalse(validate_qualification(profile, self.report, self.approval).admitted)
        profile = copy.deepcopy(self.admissible)
        profile["evidenceChecks"] = []
        self.assertFalse(validate_qualification(profile, self.report, self.approval).admitted)

    def test_rejects_contradictory_service_and_reason_evidence(self):
        self.assert_rejected("GPU_UNAVAILABLE_IN_SERVICE", lambda report: report.update(serviceContextPassed=False))
        self.assert_rejected("GPU_QUALIFICATION_FAILED", lambda report: report.update(reasonCodes=["CPU_ONLY_UNSUPPORTED"]))
        self.assert_rejected("GPU_QUALIFICATION_FAILED", lambda report: report.update(deviceLabel=None))

    def test_rejects_unsafe_metrics_or_unbound_execution_method(self):
        report = copy.deepcopy(self.report)
        report["coldWallMilliseconds"] = float("nan")
        self.assertFalse(validate_qualification(self.admissible, report, self.approval).admitted)
        self.assert_rejected("GPU_QUALIFICATION_FAILED", lambda report: report.update(warmWallMilliseconds=True))
        self.assert_rejected("INSUFFICIENT_MEMORY", lambda report: report.update(peakGpuMemoryBytes=None))
        self.assert_rejected("INSUFFICIENT_MEMORY", lambda report: report.update(peakGpuMemoryBytes=5000))
        self.assert_rejected("GPU_QUALIFICATION_FAILED", lambda report: report["referenceMetrics"].update(rms=0.1))
        self.assert_rejected("GPU_QUALIFICATION_FAILED", lambda report: report["executionEvidence"].update(method="provider-list"))

    def test_exact_wire_report_is_matched_without_trusting_self_attestation(self):
        wire = {
            "profileId": self.admissible["profileId"], "modelSha256": "a" * 64,
            "fixtureSha256": "b" * 64, "acceleratorUsed": True,
            "provider": self.admissible["provider"], "deviceLabel": "device",
            "wallMilliseconds": 1200, "peakRamBytes": None, "peakGpuMemoryBytes": None,
            "outputValid": True, "referenceCheckPassed": True,
            "serviceContextPassed": True, "reasonCodes": [],
        }
        decision = validate_runtime_report(self.admissible, wire, approval=self.approval)
        self.assertTrue(decision.admitted)
        self.assertFalse(validate_runtime_report(self.profile, wire, approval=None).admitted)
        self.assertFalse(validate_runtime_report(self.admissible, wire, approval="e" * 64).admitted)

    def test_malformed_candidate_approval_and_policy_values_fail_closed(self):
        for key, value in (("os", []), ("arch", {}), ("provider", None), ("status", True)):
            profile = copy.deepcopy(self.admissible)
            profile[key] = value
            with self.subTest(candidate_key=key):
                self.assertFalse(validate_qualification(profile, self.report, self.approval).admitted)

        malformed_approvals = (
            ApprovedEvidenceRecord(self.admissible["profileId"], 42, "approval"),
            ApprovedEvidenceRecord([], "e" * 64, "approval"),
            ApprovedEvidenceRecord(self.admissible["profileId"], "e" * 64, None),
        )
        for approval in malformed_approvals:
            with self.subTest(approval=approval):
                self.assertFalse(validate_qualification(self.admissible, self.report, approval).admitted)

        for key in self.admissible["qualificationPolicy"]:
            profile = copy.deepcopy(self.admissible)
            profile["qualificationPolicy"][key] = "bad"
            with self.subTest(policy_key=key):
                self.assertFalse(validate_qualification(profile, self.report, self.approval).admitted)

    def test_nested_evidence_and_wire_numbers_are_safely_bounded(self):
        for section, key, value in (
            ("executionEvidence", "acceleratedNodeCount", []),
            ("executionEvidence", "neuralNodeCount", 10**100),
            ("referenceMetrics", "maxAbs", float("inf")),
            ("referenceMetrics", "rms", True),
        ):
            report = copy.deepcopy(self.report)
            report[section][key] = value
            self.assertFalse(validate_qualification(self.admissible, report, self.approval).admitted)

        wire = {
            "profileId": self.admissible["profileId"], "modelSha256": "a" * 64,
            "fixtureSha256": "b" * 64, "acceleratorUsed": True,
            "provider": self.admissible["provider"], "deviceLabel": "device",
            "wallMilliseconds": 1200, "peakRamBytes": None, "peakGpuMemoryBytes": None,
            "outputValid": True, "referenceCheckPassed": True,
            "serviceContextPassed": True, "reasonCodes": [],
        }
        for key in ("wallMilliseconds", "peakRamBytes", "peakGpuMemoryBytes"):
            for value in (0, -1, True, float("nan"), float("inf"), 10**100):
                candidate = copy.deepcopy(wire)
                candidate[key] = value
                with self.subTest(wire_key=key, value=value):
                    self.assertFalse(validate_runtime_report(self.admissible, candidate, approval=self.approval).admitted)

    def test_vendor_and_provider_must_be_supported_and_consistent(self):
        for vendor in ([], {}, None, True, "unknown"):
            profile = copy.deepcopy(self.admissible)
            profile["gpuVendor"] = vendor
            with self.subTest(vendor=vendor):
                self.assertFalse(validate_qualification(profile, self.report, self.approval).admitted)
        profile = copy.deepcopy(self.admissible)
        profile["gpuVendor"] = "apple"
        self.assertFalse(validate_qualification(profile, self.report, self.approval).admitted)

    def test_all_offline_boolean_fields_require_exact_booleans(self):
        boolean_fields = (
            "acceleratorUsed", "outputValid", "outputFinite",
            "referenceCheckPassed", "cancellationPassed", "longClipPassed",
            "serviceContextPassed",
        )
        for key in boolean_fields:
            for value in (0, 1, "true", None):
                report = copy.deepcopy(self.report)
                report[key] = value
                with self.subTest(key=key, value=value):
                    approval = ApprovedEvidenceRecord(
                        self.admissible["profileId"],
                        evidence_sha256(report),
                        "v01-native-evidence-001",
                    )
                    self.assertFalse(validate_qualification(self.admissible, report, approval).admitted)


if __name__ == "__main__":
    unittest.main()
