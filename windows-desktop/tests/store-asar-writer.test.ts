import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

const component = resolve(import.meta.dirname, ".."),
  execute = promisify(execFile),
  roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function run(body: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "musicmute-asar-writer-test-")),
  );
  roots.push(root);
  const module = join(root, "writer.mjs");
  await build({
    entryPoints: [join(component, "packaging/store/asar-writer.ts")],
    outfile: module,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "silent",
  });
  const script = `
    import { createRequire } from 'node:module';
    import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
    import { createReadStream } from 'node:fs';
    import { Readable } from 'node:stream';
    import { pathToFileURL } from 'node:url';
    import { join, dirname } from 'node:path';
    import { StoreAsarWriterJoin } from ${JSON.stringify(module)};
    const component = ${JSON.stringify(component)}, stage = ${JSON.stringify(root)};
    const require = createRequire(join(component, 'package.json')), api = require('@electron/asar');
    const original = api.createPackageFromStreams, fs = require('@electron/asar/lib/wrapped-fs.js').default, originalStream = fs.createWriteStream;
    const archive = join(stage, 'electron-output/win-unpacked/resources/app.asar');
    await mkdir(dirname(archive), {recursive:true});
    const input = join(stage,'input.json'), payload = Buffer.from(JSON.stringify({sample:'z'.repeat(32768)}));
    await writeFile(input,payload);
    const rows = [{path:'packaged-resources.json',type:'file',unpacked:false,stat:await stat(input),streamGenerator:()=>createReadStream(input)}];
    const lease = await StoreAsarWriterJoin.open(component,stage);
    const namespace = await import(pathToFileURL(require.resolve('@electron/asar')).href);
    ${body}
  `;
  return execute(process.execPath, ["--input-type=module", "-e", script], {
    cwd: component,
    timeout: 10000,
    maxBuffer: 65536,
  });
}

describe("isolated Store builder actual ASAR writer lifetime", () => {
  it("joins the actual source-pinned writer before returning, verifies bytes and restores only its exports", async () => {
    const result = await run(`
      const writer=await namespace.createPackageFromStreams(archive,rows);
      await lease.assertCompleted();
      const bytes=api.extractFile(archive,'packaged-resources.json');
      if(!writer.closed||!writer.writableFinished||!bytes.equals(payload))throw Error('ACTUAL_WRITER_READBACK_FAILED');
      await lease.close(); await lease.close();
      if(api.createPackageFromStreams!==original||fs.createWriteStream!==originalStream)throw Error('RESTORE_FAILED');
      console.log(JSON.stringify({closed:writer.closed,finished:writer.writableFinished,bytesMatch:true}));
    `);
    expect(JSON.parse(result.stdout)).toEqual({
      closed: true,
      finished: true,
      bytesMatch: true,
    });
  });
  it("denies a different output before creating it and does not confer completion", async () => {
    const result = await run(`
      const other=join(stage,'other.asar');
      let denied=false;try{await namespace.createPackageFromStreams(other,rows);}catch(e){denied=e.message==='STORE_GUI_ASAR_WRITER_DENIED';}
      let completed=false;try{await lease.assertCompleted();completed=true;}catch{}
      let absent=false;try{await stat(other);}catch(e){absent=e.code==='ENOENT';}
      await lease.close();
      console.log(JSON.stringify({denied,completed,absent}));
    `);
    expect(JSON.parse(result.stdout)).toEqual({
      denied: true,
      completed: false,
      absent: true,
    });
  });
  it("rejects concurrent installation and a second archive without replacing the first output", async () => {
    const result = await run(`
      let concurrent=false;try{await StoreAsarWriterJoin.open(component,stage);}catch(e){concurrent=e.message==='STORE_GUI_ASAR_WRITER_DENIED';}
      const writer=await namespace.createPackageFromStreams(archive,rows), before=await readFile(archive);
      let replay=false;try{await namespace.createPackageFromStreams(archive,rows);}catch(e){replay=e.message==='STORE_GUI_ASAR_WRITER_DENIED';}
      await lease.assertCompleted();await lease.close();
      console.log(JSON.stringify({concurrent,replay,unchanged:before.equals(await readFile(archive)),closed:writer.closed}));
    `);
    expect(JSON.parse(result.stdout)).toEqual({
      concurrent: true,
      replay: true,
      unchanged: true,
      closed: true,
    });
  });
  it("retains the original input failure, closes its real output and restores both exact exports", async () => {
    const result = await run(`
      let generated=0;
      const failed=[{...rows[0],streamGenerator:()=>{if(++generated===1)return createReadStream(input);const failed=new Readable({read(){this.destroy(Error('OWNED_INPUT_FAILURE'));}});return failed;}}];
      let originalFailure=false;try{await namespace.createPackageFromStreams(archive,failed);}catch(e){originalFailure=e.message==='OWNED_INPUT_FAILURE';}
      await lease.close();
      console.log(JSON.stringify({originalFailure,actualOutputCreated:(await stat(archive)).size>0,restored:api.createPackageFromStreams===original&&fs.createWriteStream===originalStream}));
    `);
    expect(JSON.parse(result.stdout)).toEqual({
      originalFailure: true,
      actualOutputCreated: true,
      restored: true,
    });
  });
});
