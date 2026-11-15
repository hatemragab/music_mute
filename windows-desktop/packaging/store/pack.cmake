# This fixed project executes only inside the separately approved QA CMake Job.
# No signing, installation, publication, arbitrary command, overwrite or PATH.
set(tool "C:/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64/MakeAppx.exe")
set(tool_hash "00fff202b71c1266b8c3899701e42b5468ea153b2b33a0a47215fe27695f16d0")
if(NOT EXISTS "${tool}" OR IS_SYMLINK "${tool}")
  message(FATAL_ERROR "STORE_MAKEAPPX_REQUIRED")
endif()
file(SIZE "${tool}" tool_bytes)
file(SHA256 "${tool}" observed_tool_hash)
if(NOT tool_bytes EQUAL 584024 OR NOT observed_tool_hash STREQUAL tool_hash)
  message(FATAL_ERROR "STORE_MAKEAPPX_IDENTITY_INVALID")
endif()
get_filename_component(project "${CMAKE_CURRENT_LIST_FILE}" DIRECTORY)
get_filename_component(stage "${project}" DIRECTORY)
file(READ "${project}/pack-inputs.json" inputs LIMIT 8388609)
string(LENGTH "${inputs}" input_bytes)
if(input_bytes GREATER 8388608)
  message(FATAL_ERROR "STORE_PACK_INPUTS_INVALID")
endif()
string(SHA256 inputs_hash "${inputs}")
string(JSON version GET "${inputs}" version)
string(JSON role GET "${inputs}" role)
if(NOT version EQUAL 1 OR NOT role MATCHES "^(gui|worker)$")
  message(FATAL_ERROR "STORE_PACK_INPUTS_INVALID")
endif()
if(role STREQUAL "gui")
  set(package "${stage}/gui")
  set(artifact "${stage}/MusicMute-0.1.0.0-x64.msix")
else()
  set(package "${stage}/worker")
  set(artifact "${stage}/MusicMuteWorker-0.1.3.0-x64.msix")
endif()
if(EXISTS "${artifact}" OR IS_SYMLINK "${package}")
  message(FATAL_ERROR "STORE_PACK_STAGE_INVALID")
endif()
# string(JSON) reparses its entire argument on every GET. Parse once per pass
# with the qualified Node; retain both complete file/hash/census checks.
set(node "C:/MusicMuteBuild/node-runtime/node.exe")
set(node_hash "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de")
if(NOT EXISTS "${node}" OR IS_SYMLINK "${node}")
  message(FATAL_ERROR "STORE_PACK_NODE_REQUIRED")
endif()
file(SIZE "${node}" node_bytes)
file(SHA256 "${node}" observed_node_hash)
if(NOT node_bytes EQUAL 92534088 OR NOT observed_node_hash STREQUAL node_hash)
  message(FATAL_ERROR "STORE_PACK_NODE_IDENTITY_INVALID")
endif()
set(check_inputs_code [==[
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const chunk = Buffer.alloc(1024 * 1024);
const fail = code => { throw Error(code); };
const same = (a, b) => {
  for (const key of ['dev', 'ino', 'size', 'nlink', 'ctimeNs', 'mtimeNs', 'birthtimeNs'])
    if (a[key] !== b[key]) fail('STORE_PACK_INPUT_CHANGED');
};
function hashFile(file, pin, retain = false) {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      before.size !== BigInt(pin.bytes)) fail('STORE_PACK_INPUT_CHANGED');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let failure, raw, result;
  try {
    const held = fs.fstatSync(fd, { bigint: true }); same(before, held);
    const hash = crypto.createHash('sha256');
    raw = retain ? Buffer.alloc(pin.bytes) : null;
    let at = 0;
    while (at < pin.bytes) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, pin.bytes - at), at);
      if (!n) fail('STORE_PACK_INPUT_CHANGED');
      hash.update(chunk.subarray(0, n)); raw?.set(chunk.subarray(0, n), at); at += n;
    }
    if (fs.readSync(fd, chunk, 0, 1, at)) fail('STORE_PACK_INPUT_CHANGED');
    result = hash.digest('hex');
    if (result !== pin.sha256) fail('STORE_PACK_INPUT_CHANGED');
    same(held, fs.fstatSync(fd, { bigint: true })); same(held, fs.lstatSync(file, { bigint: true }));
  } catch (error) { failure = error; }
  try { fs.closeSync(fd); } catch { failure = Error('STORE_PACK_INPUT_CHANGED'); }
  if (failure) throw failure;
  return raw;
}
try {
  if (process.argv.length !== 5 || process.version !== 'v24.18.0') fail('STORE_PACK_INPUTS_INVALID');
  const [inputFile, packageRoot, inputHash, role] = process.argv.slice(1);
  const inputSize = fs.lstatSync(inputFile).size;
  if (inputSize < 1 || inputSize > 8388608 || !/^[0-9a-f]{64}$/.test(inputHash)) fail('STORE_PACK_INPUTS_INVALID');
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
    hashFile(inputFile, { bytes: inputSize, sha256: inputHash }, true)));
  if (!input || input.version !== 1 || input.role !== role || !/^(gui|worker)$/.test(role) ||
      !Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > 65542)
    fail('STORE_PACK_INPUTS_INVALID');
  const expected = [], seen = new Set();
  for (const row of input.entries) {
    if (!row || typeof row.path !== 'string' || !row.path ||
        /[;\\$"\r\n:<>|?*]/.test(row.path) || /(^|\/)\.\.?($|\/)/.test(row.path) ||
        row.path.startsWith('/') || row.path.split('/').some(part => !part) ||
        !Number.isSafeInteger(row.bytes) || row.bytes < 0 || typeof row.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(row.sha256) || seen.has(row.path.toLowerCase())) fail('STORE_PACK_INPUTS_INVALID');
    seen.add(row.path.toLowerCase()); expected.push(row.path);
    hashFile(path.join(packageRoot, ...row.path.split('/')), row);
  }
  const actual = [];
  function walk(directory, prefix = '', depth = 0) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || depth > 64) fail('STORE_PACK_FILE_SET_CHANGED');
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), key = prefix ? prefix + '/' + name : name;
      const info = fs.lstatSync(file);
      if (info.isSymbolicLink()) fail('STORE_PACK_FILE_SET_CHANGED');
      if (info.isDirectory()) walk(file, key, depth + 1);
      else if (info.isFile()) actual.push(key);
      else fail('STORE_PACK_FILE_SET_CHANGED');
      if (actual.length > expected.length) fail('STORE_PACK_FILE_SET_CHANGED');
    }
  }
  walk(packageRoot); actual.sort(); expected.sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('STORE_PACK_FILE_SET_CHANGED');
} catch (error) {
  const code = /^STORE_PACK_[A-Z_]+$/.test(error?.message) ? error.message : 'STORE_PACK_INPUTS_INVALID';
  process.stderr.write(code + '\n'); process.exitCode = 1;
}
]==])
function(check_inputs)
  execute_process(COMMAND "${node}" -e "${check_inputs_code}"
    "${project}/pack-inputs.json" "${package}" "${inputs_hash}" "${role}"
    RESULT_VARIABLE input_result OUTPUT_QUIET ERROR_VARIABLE input_error)
  if(NOT input_result EQUAL 0)
    message(FATAL_ERROR "STORE_PACK_INPUT_CHECK_FAILED:${input_error}")
  endif()
endfunction()
check_inputs()
# Validation stays enabled. /o and /nv are deliberately absent.
execute_process(COMMAND "${tool}" pack /d "${package}" /p "${artifact}"
  TIMEOUT 600 RESULT_VARIABLE result
  OUTPUT_FILE "${project}/makeappx.stdout.log"
  ERROR_FILE "${project}/makeappx.stderr.log")
check_inputs()
file(SHA256 "${tool}" after_tool_hash)
file(SHA256 "${node}" after_node_hash)
file(SIZE "${node}" after_node_bytes)
if(NOT result EQUAL 0 OR NOT after_tool_hash STREQUAL tool_hash OR NOT after_node_hash STREQUAL node_hash OR NOT after_node_bytes EQUAL 92534088 OR NOT EXISTS "${artifact}")
  message(FATAL_ERROR "STORE_PACK_FAILED")
endif()
file(SIZE "${artifact}" artifact_bytes)
file(SHA256 "${artifact}" artifact_sha)
if(artifact_bytes LESS 1)
  message(FATAL_ERROR "STORE_PACK_FAILED")
endif()
file(WRITE "${project}/pack-result.json"
  "{\"version\":1,\"role\":\"${role}\",\"purpose\":\"unsigned-store-upload-candidate\",\"packed\":true,\"installable\":false,\"releaseReady\":false,\"signed\":false,\"published\":false,\"bytes\":${artifact_bytes},\"sha256\":\"${artifact_sha}\"}\n")
message(STATUS "STORE_UNSIGNED_UPLOAD_PACKED")
