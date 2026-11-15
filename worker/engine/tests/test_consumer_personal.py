"""Code fixtures only: no DirectML, model loading, Windows identity or network."""
import tempfile
import os
import io
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from musicmute_engine.consumer_personal import PersonalExecutor, PersonalSessionExecutor, bounded_tool, run, validate_local_source
from musicmute_engine.pipeline import ProcessingFailure
from musicmute_engine.artifacts import ModelArtifactError
from musicmute_engine.recipes import MODEL_BYTES, MODEL_FILENAME
JOB="11111111-1111-4111-8111-111111111111"
SID="S-1-5-21-100-200-300-1001"
GPU={"source":"DXGI EnumAdapters1/GetDesc1","deviceIndex":3,"name":"Fixture GPU","vendorId":4098,"deviceId":1,"subsystemId":1,"revision":1,"driverVersion":"1.2.3.4","luid":"0000000000000001","dedicatedVideoMemoryBytes":1024,"sharedSystemMemoryLimitBytes":1024}
class ConsumerPersonalTests(unittest.TestCase):
 def setUp(self):
  self.environment=patch.dict(os.environ);self.environment.start()
  self.temporary=tempfile.TemporaryDirectory();self.root=Path(self.temporary.name);self.work=self.root/"personal"/"jobs"/JOB;self.work.mkdir(parents=True)
  self.source=self.root/"personal"/"inputs"/"source.wav";self.source.parent.mkdir(parents=True);self.source.write_bytes(b"fixture input")
  self.model=self.root/"models"/MODEL_FILENAME;self.model.parent.mkdir()
  # Sparse byte-count fixture, never a genuine model or GPU assertion.
  with self.model.open("wb") as stream:stream.truncate(MODEL_BYTES)
  self.configuration={"version":1,"jobId":JOB,"workRoot":str(self.work),"releaseRoot":str(self.root/"release"),"modelPath":str(self.model),"sid":SID,"gpuIdentity":GPU}
 def tearDown(self):self.temporary.cleanup();self.environment.stop()
 def test_inclusive_twenty_minute_limit_before_model_execution(self):
  self.assertEqual(validate_local_source(self.source,Path("ffprobe"),lambda *_:SimpleNamespace(duration_seconds=1200)),1200)
  for seconds in (1200.0001,0,-1,float("nan"),float("inf")):
   with self.assertRaises(ProcessingFailure) as caught:validate_local_source(self.source,Path("ffprobe"),lambda *_:SimpleNamespace(duration_seconds=seconds))
   self.assertEqual(caught.exception.code,"DURATION_LIMIT")
 def test_only_one_hardlink_regular_input_is_accepted(self):
  self.source.with_name("alias.wav").hardlink_to(self.source)
  with self.assertRaises(ProcessingFailure):validate_local_source(self.source,Path("ffprobe"),lambda *_:SimpleNamespace(duration_seconds=1))
 def test_model_fingerprint_changes_require_prepare(self):
  executor=PersonalExecutor(self.configuration);self.assertEqual(executor._model(self.model.parent),self.model)
  with self.model.open("r+b") as stream:stream.write(b"changed")
  with self.assertRaises(ModelArtifactError):executor._model(self.model.parent)
 def test_windows_identity_is_required_even_for_injected_pipeline(self):
  executor=PersonalExecutor(self.configuration)
  with patch("musicmute_engine.consumer_personal.sys.platform","darwin"):
   with self.assertRaises(ProcessingFailure) as caught:executor.execute({"operation":"process","input":{},"recipeId":"kim-vocals-v2"},lambda _:None,lambda *_:None)
  self.assertEqual(caught.exception.code,"GPU_UNSUPPORTED")
 def test_fixed_directml_recipe_and_original_input_are_preserved(self):
  executor=PersonalExecutor(self.configuration);calls=[];executor.pipeline=SimpleNamespace(process=lambda request,*_:calls.append(request) or {"attemptId":JOB})
  with patch("musicmute_engine.consumer_personal.sys.platform","win32"),patch("musicmute_engine.consumer_personal.service_identity",return_value=SID),patch("musicmute_engine.consumer_personal.resolve_adapter",return_value=GPU),patch("musicmute_engine.consumer_personal.normalize_original",return_value=(self.source,1200,None)),patch("musicmute_engine.consumer_personal.verify_input_identity"):
   result=executor.execute({"operation":"process","input":{"path":str(self.source),"bytes":13,"sha256":"A"*43+"="},"recipeId":"kim-vocals-v2"},lambda _:None,lambda *_:None)
  self.assertEqual(result,{"attemptId":JOB,"sourceDurationSeconds":1200});self.assertEqual(calls[0].provider,"directml");self.assertEqual(calls[0].directml_device_id,3);self.assertFalse(calls[0].recipe["trimEnabled"]);self.assertEqual(self.source.read_bytes(),b"fixture input");self.assertEqual(calls[0].input_path.parent.name,JOB)
 def test_trim_recipe_executes_real_trimmer_profile_on_the_same_directml_device(self):
  executor=PersonalExecutor(self.configuration);calls=[];executor.pipeline=SimpleNamespace(process=lambda request,*_:calls.append(request) or {"attemptId":JOB,"editMap":{"version":1,"rangeCount":2,"chunks":[[{"sourceStart":0,"sourceEnd":44100,"outputStart":0,"outputEnd":44100},{"sourceStart":88200,"sourceEnd":132300,"outputStart":44100,"outputEnd":88200}]]}})
  with patch("musicmute_engine.consumer_personal.sys.platform","win32"),patch("musicmute_engine.consumer_personal.service_identity",return_value=SID),patch("musicmute_engine.consumer_personal.resolve_adapter",return_value=GPU),patch("musicmute_engine.consumer_personal.normalize_original",return_value=(self.source,1200,None)),patch("musicmute_engine.consumer_personal.verify_input_identity"):
   result=executor.execute({"operation":"process","input":{"path":str(self.source),"bytes":13,"sha256":"A"*43+"="},"recipeId":"kim-vocals-v2-trim"},lambda _:None,lambda *_:None)
  self.assertTrue(calls[0].recipe["trimEnabled"]);self.assertEqual(calls[0].recipe["recipeDigest"],"97198c83fd88101420299121bf6ef0f81d350f6228762c2892d817283241fc04");self.assertEqual(calls[0].provider,"directml");self.assertEqual(result["editMap"]["rangeCount"],2);self.assertEqual(self.source.read_bytes(),b"fixture input")
 def test_caller_cannot_supply_provider_or_external_tool(self):
  executor=PersonalExecutor(self.configuration)
  with self.assertRaises(ProcessingFailure):executor.execute({"operation":"shell","command":"whoami"},lambda _:None,lambda *_:None)
  with self.assertRaises(ProcessingFailure):executor.execute({"operation":"downloader","arguments":[],"output":"../outside","timeout":120,"maximum":65536},lambda _:None,lambda *_:None)
  with self.assertRaises(ProcessingFailure):executor.execute({"operation":"process","input":{},"recipeId":"kim-vocals-v2","provider":"cpu"},lambda _:None,lambda *_:None)

class PersonalToolConsoleTests(unittest.TestCase):
 def test_only_windows_console_tools_detach_without_breakaway_or_changed_pipes(self):
  for system in ("win32","darwin"):
   with self.subTest(system=system),tempfile.TemporaryDirectory() as temporary:
    root=Path(temporary);output=root/"metadata.jsonl";arguments=["private-tool","--fixture"]
    process=SimpleNamespace(stdout=io.BytesIO(b"fixture-output"),stderr=io.BytesIO(b""),wait=Mock(return_value=0),kill=Mock())
    with patch("musicmute_engine.consumer_personal.sys.platform",system),patch("musicmute_engine.consumer_personal.subprocess.Popen",return_value=process) as spawn:
     bounded_tool(arguments,root,output,65536,120)
    self.assertEqual(output.read_bytes(),b"fixture-output");self.assertTrue(process.stdout.closed);self.assertTrue(process.stderr.closed)
    self.assertEqual(spawn.call_args.args,(arguments,));options=spawn.call_args.kwargs
    self.assertEqual(options["creationflags"],0x8 if system=="win32" else 0)
    self.assertEqual(options["creationflags"] & 0x01000000,0)
    self.assertEqual(options["cwd"],root);self.assertEqual(options["stdin"],subprocess.DEVNULL)
    self.assertEqual(options["stdout"],subprocess.PIPE);self.assertEqual(options["stderr"],subprocess.PIPE)
    self.assertTrue(options["close_fds"]);self.assertNotIn("shell",options);self.assertIsInstance(options["env"],dict)
    process.wait.assert_called_once_with(timeout=120);process.kill.assert_not_called()
 def test_detached_tool_timeout_still_kills_waits_closes_and_removes_partial_result(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);output=root/"metadata.jsonl"
   process=SimpleNamespace(stdout=io.BytesIO(b"partial"),stderr=io.BytesIO(b""),wait=Mock(side_effect=[subprocess.TimeoutExpired("fixture",120),0]),kill=Mock())
   with patch("musicmute_engine.consumer_personal.sys.platform","win32"),patch("musicmute_engine.consumer_personal.subprocess.Popen",return_value=process),self.assertRaises(ProcessingFailure) as caught:
    bounded_tool(["private-tool"],root,output,65536,120)
   self.assertEqual(caught.exception.code,"SOURCE_UNAVAILABLE");self.assertFalse(output.exists())
   process.kill.assert_called_once_with();self.assertEqual(process.wait.call_count,2)
   self.assertTrue(process.stdout.closed);self.assertTrue(process.stderr.closed)
 def test_detached_tool_output_limit_still_rejects_and_removes_result(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);output=root/"metadata.jsonl"
   process=SimpleNamespace(stdout=io.BytesIO(b"x"*65537),stderr=io.BytesIO(b""),wait=Mock(return_value=0),kill=Mock())
   with patch("musicmute_engine.consumer_personal.sys.platform","win32"),patch("musicmute_engine.consumer_personal.subprocess.Popen",return_value=process),self.assertRaises(ProcessingFailure):
    bounded_tool(["private-tool"],root,output,65536,120)
   self.assertFalse(output.exists());process.kill.assert_called_once_with()


class OriginalNormalizationTests(unittest.TestCase):
 def test_video_original_is_guarded_aac_and_never_changes_selected_source(self):
  from musicmute_engine.consumer_personal import normalize_original
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);source=root/"source.mkv";source.write_bytes(b"selected-video-fixture");calls=[]
   def tool(arguments,*args,**kwargs):
    calls.append(arguments)
    if arguments[-1]==str(source):return SimpleNamespace(stdout='{"streams":[{"codec_type":"audio"},{"codec_type":"video"}]}')
    (root/"original.m4a").write_bytes(b"encoded-aac-fixture")
    return SimpleNamespace(stdout="")
   with patch("musicmute_engine.consumer_personal.validate_local_source",return_value=6),patch("musicmute_engine.consumer_personal._run",side_effect=tool),patch("musicmute_engine.consumer_personal.probe_audio",return_value=SimpleNamespace(duration_seconds=6.02,sample_rate=44100,channels=2)):
    path,duration,declaration=normalize_original(source,root,root/"release")
   self.assertEqual(source.read_bytes(),b"selected-video-fixture");self.assertEqual(path.name,"original.m4a");self.assertEqual(duration,6)
   self.assertEqual(declaration["contentType"],"audio/mp4");self.assertEqual(declaration["bytes"],19)
   self.assertIn("-n",calls[1]);self.assertNotIn("-y",calls[1]);self.assertIn("aac",calls[1]);self.assertIn("30000000",calls[1])

class PersonalSessionTests(unittest.TestCase):
 def setUp(self):
  self.environment=patch.dict(os.environ);self.environment.start()
  self.temporary=tempfile.TemporaryDirectory();self.root=Path(self.temporary.name).resolve()
  self.personal=self.root/"personal";self.jobs=self.personal/"jobs";self.jobs.mkdir(parents=True)
  self.session_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  self.session_root=self.personal/"engine-session"/self.session_id;self.session_root.mkdir(parents=True)
  self.release=self.root/"release";self.release.mkdir()
  self.model=self.root/"models"/MODEL_FILENAME;self.model.parent.mkdir()
  with self.model.open("wb") as stream:stream.truncate(MODEL_BYTES)
  self.source=self.personal/"inputs"/"source.wav";self.source.parent.mkdir();self.source.write_bytes(b"fixture input")
  self.configuration={"version":2,"sessionId":self.session_id,"sessionRoot":str(self.session_root),"jobsRoot":str(self.jobs),"releaseRoot":str(self.release),"modelPath":str(self.model),"sid":SID,"gpuIdentity":dict(GPU)}
  self.patches=[patch("musicmute_engine.consumer_personal.sys.platform","win32"),patch("musicmute_engine.consumer_personal.service_identity",return_value=SID),patch("musicmute_engine.consumer_personal.resolve_adapter",return_value=GPU),patch("musicmute_engine.consumer_personal.normalize_original",return_value=(self.source,1200,None)),patch("musicmute_engine.consumer_personal.verify_input_identity")]
  for item in self.patches:item.start()
 def tearDown(self):
  for item in reversed(self.patches):item.stop()
  self.temporary.cleanup();self.environment.stop()
 def payload(self,job_id=JOB,recipe_id="kim-vocals-v2"):
  (self.jobs/job_id).mkdir(exist_ok=True)
  return {"operation":"process","jobId":job_id,"input":{"path":str(self.source),"bytes":13,"sha256":"A"*43+"="},"recipeId":recipe_id}
 def prepared_session(self):
  session=PersonalSessionExecutor(self.configuration)
  # Code fixture: distinct graph/STFT sentinels, never real GPU evidence.
  model=SimpleNamespace(ort_session=object(),stft=object(),audio=None,callback=None,output=None)
  def detach():model.audio=None;model.callback=None;model.output=None
  separator=SimpleNamespace(detach_job=detach)
  session.pipeline._separator_factory=Mock(return_value=separator)
  calls=[]
  def process(request,progress,windows):
   path=session.pipeline._verified_model(request.model_cache_root)
   loaded=session.pipeline._get_separator(request.provider,path,request.directml_device_id)
   self.assertIs(loaded,separator)
   model.audio=bytearray(b"job audio");model.callback=windows;model.output=request.attempt_directory
   calls.append(request)
   return {"attemptId":request.attempt_id}
  session.pipeline.process=Mock(side_effect=process)
  return session,model,calls
 def test_same_pipeline_and_graph_across_independent_jobs_and_both_exact_recipes(self):
  session,model,calls=self.prepared_session();pipeline=session.pipeline;graph=model.ort_session;stft=model.stft
  first=session.execute(self.payload(),lambda _:None,lambda *_:None)
  second_id="22222222-2222-4222-8222-222222222222"
  second=session.execute(self.payload(second_id,"kim-vocals-v2-trim"),lambda _:None,lambda *_:None)
  self.assertIs(session.pipeline,pipeline);self.assertIs(model.ort_session,graph);self.assertIs(model.stft,stft)
  pipeline._separator_factory.assert_called_once_with("directml",self.model,3)
  self.assertEqual(first["sessionCompletion"],{"sessionId":self.session_id,"jobId":JOB,"detached":True,"modelReused":False})
  self.assertEqual(second["sessionCompletion"],{"sessionId":self.session_id,"jobId":second_id,"detached":True,"modelReused":True})
  self.assertEqual([call.recipe["recipeDigest"] for call in calls],["23e22a5fe3b9a604f7ff5241f0fa7194bacf153fc37df83d83898949610a89d9","97198c83fd88101420299121bf6ef0f81d350f6228762c2892d817283241fc04"])
  self.assertEqual([call.recipe["recipeRevision"] for call in calls],[6,6])
  self.assertFalse(calls[0].recipe["trimEnabled"]);self.assertTrue(calls[1].recipe["trimEnabled"])
  self.assertIsNone(model.audio);self.assertIsNone(model.callback);self.assertIsNone(model.output)
  self.assertEqual(os.environ["TEMP"],str(self.session_root));self.assertNotEqual(calls[0].attempt_directory,calls[1].attempt_directory)
 def test_model_replacement_rejects_before_inference_and_poisons_cache(self):
  session,model,_=self.prepared_session();session.execute(self.payload(),lambda _:None,lambda *_:None)
  replacement=self.model.with_name("replacement.onnx")
  with replacement.open("wb") as stream:stream.truncate(MODEL_BYTES)
  os.replace(replacement,self.model)
  with self.assertRaises(ModelArtifactError):session.execute(self.payload("22222222-2222-4222-8222-222222222222"),lambda _:None,lambda *_:None)
  self.assertEqual(session.pipeline.process.call_count,1);self.assertFalse(session.pipeline.model_loaded)
  with self.assertRaises(ProcessingFailure) as caught:session.execute(self.payload("33333333-3333-4333-8333-333333333333"),lambda _:None,lambda *_:None)
  self.assertEqual(caught.exception.code,"PROCESSING_FAILED")
 def test_failure_detaches_and_never_reuses_or_reloads_same_child(self):
  session,model,_=self.prepared_session()
  def failed(*_):
   session.pipeline._get_separator("directml",self.model,3);model.audio=bytearray(b"private");model.callback=object()
   raise ProcessingFailure("SEPARATOR_FAILED","fixture")
  session.pipeline.process.side_effect=failed
  with self.assertRaises(ProcessingFailure):session.execute(self.payload(),lambda _:None,lambda *_:None)
  self.assertIsNone(model.audio);self.assertIsNone(model.callback);self.assertFalse(session.pipeline.model_loaded)
  with self.assertRaises(ProcessingFailure):session.execute(self.payload("22222222-2222-4222-8222-222222222222"),lambda _:None,lambda *_:None)
  self.assertEqual(session.pipeline.process.call_count,1)
 def test_uncertain_detach_poison_and_releases_serial_guard(self):
  session,_,_=self.prepared_session();session.pipeline.detach_job=Mock(side_effect=RuntimeError("fixture cleanup"))
  with self.assertRaises(RuntimeError):session.execute(self.payload(),lambda _:None,lambda *_:None)
  self.assertFalse(session.pipeline.model_loaded);self.assertFalse(session._lock.locked())
  with self.assertRaises(Exception):session.execute(self.payload("22222222-2222-4222-8222-222222222222"),lambda _:None,lambda *_:None)
  self.assertEqual(session.pipeline.process.call_count,1)
 def test_reentrant_request_is_rejected_before_a_second_process(self):
  session,_,_=self.prepared_session();original=session.pipeline.process.side_effect
  def reentrant(request,progress,windows):
   with self.assertRaises(ProcessingFailure):session.execute(self.payload("22222222-2222-4222-8222-222222222222"),progress,windows)
   return original(request,progress,windows)
  session.pipeline.process.side_effect=reentrant
  with self.assertRaises(ProcessingFailure):session.execute(self.payload(),lambda _:None,lambda *_:None)
  self.assertEqual(session.pipeline.process.call_count,1);self.assertFalse(session.pipeline.model_loaded)
 def test_changed_gpu_or_user_environment_rejects_without_processing(self):
  session,_,_=self.prepared_session();os.environ["TEMP"]=str(self.jobs)
  with self.assertRaises(ProcessingFailure):session.execute(self.payload(),lambda _:None,lambda *_:None)
  session.pipeline.process.assert_not_called()
 def test_changed_user_or_adapter_rejects_before_reuse(self):
  for changed in ("sid","gpu"):
   with self.subTest(changed=changed):
    session,_,_=self.prepared_session();session._resolved_adapter=dict(GPU)
    target="musicmute_engine.consumer_personal.service_identity" if changed=="sid" else "musicmute_engine.consumer_personal.resolve_adapter"
    value="S-1-5-21-100-200-300-1002" if changed=="sid" else {**GPU,"deviceIndex":4}
    with patch(target,return_value=value),self.assertRaises(ProcessingFailure):session.execute(self.payload(),lambda _:None,lambda *_:None)
    session.pipeline.process.assert_not_called()
 def test_replaced_or_redirected_directory_is_rejected_before_job_effects(self):
  session,_,_=self.prepared_session();old=self.jobs.with_name("jobs-before");self.jobs.rename(old);self.jobs.mkdir()
  with self.assertRaises(ProcessingFailure):session.execute(self.payload(),lambda _:None,lambda *_:None)
  session.pipeline.process.assert_not_called()
  self.assertFalse((self.jobs/JOB/"engine").exists())
 def test_strict_session_fields_and_job_id_prevent_path_or_provider_override(self):
  for value in ({**self.configuration,"workRoot":str(self.root)}, {**self.configuration,"version":True}, {**self.configuration,"sessionRoot":str(self.jobs)}, {**self.configuration,"gpuIdentity":{}}):
   with self.assertRaises(Exception):PersonalSessionExecutor(value)
  for job_id in (self.session_id,"../outside","not-a-uuid",True,None):
   session,_,_=self.prepared_session()
   with self.assertRaises(ProcessingFailure):session.execute({**self.payload(),"jobId":job_id},lambda _:None,lambda *_:None)
   session.pipeline.process.assert_not_called()
 def test_source_parent_traversal_or_symlink_cannot_escape_personal_tree(self):
  external=self.root/"external.wav";external.write_bytes(b"external")
  alias=self.personal/"inputs"/"alias.wav";alias.symlink_to(external)
  for source in (str(self.personal/".."/"external.wav"),str(alias),str(external)):
   session,_,_=self.prepared_session();payload=self.payload();payload["input"]["path"]=source
   with self.assertRaises(ProcessingFailure):session.execute(payload,lambda _:None,lambda *_:None)
   session.pipeline.process.assert_not_called()
   self.assertFalse((self.jobs/JOB/"engine").exists())
 def test_downloader_is_serial_job_local_and_returns_explicit_detach_ack(self):
  session,_,_=self.prepared_session();(self.jobs/JOB).mkdir()
  payload={"operation":"downloader","jobId":JOB,"arguments":[],"output":"metadata.jsonl","timeout":120,"maximum":65536}
  with patch("musicmute_engine.consumer_personal.bounded_tool") as tool:
   result=session.execute(payload,lambda _:None,lambda *_:None)
  self.assertEqual(result,{"output":"metadata.jsonl","sessionCompletion":{"sessionId":self.session_id,"jobId":JOB,"detached":True,"modelReused":False}})
  self.assertEqual(tool.call_args.args[1],self.jobs/JOB)
  self.assertEqual(tool.call_args.args[2],self.jobs/JOB/"metadata.jsonl")
  self.assertFalse(session.pipeline.model_loaded);session.pipeline.process.assert_not_called()
 def test_session_accepts_native_user_sid_families_and_rejects_invalid_authority(self):
  for sid in (SID,"S-1-12-1-100-200-300-1001"):
   session=PersonalSessionExecutor({**self.configuration,"sid":sid})
   self.assertEqual(session.configuration["sid"],sid)
  for sid in ("S-1-5-18","S-1-5-21-100-200-300-4294967296","S-1-12-1-100-200-300-10000000000","S-1-5-21-100-200-300"):
   with self.assertRaises(ProcessingFailure):PersonalSessionExecutor({**self.configuration,"sid":sid})
 def test_configuration_is_detached_from_mutable_caller_record(self):
  session,_,_=self.prepared_session();self.configuration["sid"]="changed";self.configuration["gpuIdentity"]["deviceIndex"]=15
  self.assertEqual(session.configuration["sid"],SID);self.assertEqual(session.configuration["gpuIdentity"]["deviceIndex"],3)
 def test_v2_ready_identifies_same_process_and_session_without_changing_v1_ready(self):
  for version in (1,2):
   session=PersonalSessionExecutor(self.configuration) if version==2 else SimpleNamespace(execute=lambda *_:{})
   buffer=io.BytesIO();frames=[]
   with patch("musicmute_engine.consumer_personal.isolate_protocol_output",return_value=buffer),patch("musicmute_engine.consumer_personal.write_frame",side_effect=lambda _,value:frames.append(value)),patch("musicmute_engine.consumer_personal.read_frame",return_value={"requestId":JOB,"command":"shutdown"}):
    self.assertEqual(run(JOB,session),0)
   ready=frames[0]["payload"];self.assertEqual(ready["processCapacity"],1)
   if version==2:self.assertEqual(ready["sessionEngine"],{"sessionId":self.session_id,"processId":os.getpid()})
   else:self.assertNotIn("sessionEngine",ready)


if __name__ == "__main__":
 unittest.main()
