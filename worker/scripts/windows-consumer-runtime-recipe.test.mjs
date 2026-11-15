import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const recipe = await readFile(
  new URL("./build-windows-consumer-runtime.ps1", import.meta.url),
  "utf8",
);
test("consumer recipe requires native prepared inputs, frozen offline tools and external signing", () => {
  for (const parameter of [
    "NativeBinary",
    "AgentRoot",
    "DownloaderRoot",
    "YoutubeRoot",
    "SigningKeyPath",
    "Sequence",
    "ExpiresAt",
  ])
    assert.match(
      recipe,
      new RegExp(`Mandatory = \\$true[^\\r\\n]*\\$${parameter}`),
    );
  assert.match(recipe, /v24\.18\.0/);
  assert.match(recipe, /10\.14\.0/);
  assert.match(recipe, /install --offline --frozen-lockfile --ignore-scripts/);
  assert.match(recipe, /requirements-directml\.lock\.txt/);
  assert.match(recipe, /consumer-package\.js/);
  assert.match(recipe, /ReparsePoint/);
  assert.match(recipe, /outside every package input and output tree/);
});
test("consumer recipe cannot configure a system service, mirror a model or bypass checks", () => {
  assert.doesNotMatch(
    recipe,
    /WinSW|New-Service|sc\.exe|HKLM|RunAs|ExecutionPolicy|Kim_Vocal_2|Invoke-WebRequest|skip.*(?:audit|qualif)/i,
  );
  assert.match(
    recipe,
    /Native install\/GPU\/driver\/Chrome acceptance is still required/,
  );
  assert.match(recipe, /\$LASTEXITCODE -ne 0/);
});
