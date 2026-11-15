import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import { StoreWorkerCodeAuthority } from "../browser/store-native.js";
import type { HostContext } from "../host-context.js";
import { PrepareFailure, preparationFailure } from "./controller.js";
import { PREPARATION_FIXTURE, preparationFixture } from "./fixture.js";
import {
  hashPrivateFile,
  verifyPrivateFile,
  writePrivateAtomic,
} from "./private-files.js";
import { downloadStoreModel } from "./store-model-transfer.js";

/** Store preparation changes only guarded mutable model/fixture data. Code is
 * supplied by the living independently registered Worker, never a runtime ZIP.
 * This stage preserves the same pin, resumable transfer and six-second fixture;
 * it writes no qualification, activation or Ready marker. */
export async function prepareStoreModel(
  host: HostContext,
  code: StoreWorkerCodeAuthority,
  signal: AbortSignal,
  progress: (completed: number, total: number) => void,
  options: { fetch?: typeof fetch } = {},
) {
  signal.throwIfAborted();
  StoreWorkerCodeAuthority.prototype.assertDataNative.call(code, host.native);
  const binding =
    await StoreWorkerCodeAuthority.prototype.preparationBinding.call(code);
  if (binding.sid !== host.identity.sid)
    throw new PrepareFailure("INTEGRITY_INVALID");
  try {
    if (!host.native.recoverStoreModelPublication)
      throw new PrepareFailure("INTEGRITY_INVALID");
    await host.native.recoverStoreModelPublication();
    signal.throwIfAborted();
    StoreWorkerCodeAuthority.prototype.assertDataNative.call(code, host.native);
    await StoreWorkerCodeAuthority.prototype.revalidate.call(code);
    let valid = false;
    try {
      valid =
        (await hashPrivateFile(
          host,
          `models\\${MODEL.filename}`,
          MODEL.bytes,
          signal,
        )) === MODEL.sha256;
    } catch {
      signal.throwIfAborted();
    }
    if (!valid) {
      await downloadStoreModel({
        host,
        code,
        signal,
        fetch: options.fetch ?? fetch,
        onProgress: progress,
      });
      signal.throwIfAborted();
      await StoreWorkerCodeAuthority.prototype.revalidate.call(code);
    }
    const model = await verifyPrivateFile(
      host,
      `models\\${MODEL.filename}`,
      MODEL.bytes,
      signal,
    );
    if (model.sha256 !== MODEL.sha256)
      throw new PrepareFailure("INTEGRITY_INVALID");
    await writePrivateAtomic(
      host,
      `fixtures\\${PREPARATION_FIXTURE.filename}`,
      preparationFixture(),
    );
    signal.throwIfAborted();
    const current =
      await StoreWorkerCodeAuthority.prototype.preparationBinding.call(code);
    if (JSON.stringify(current) !== JSON.stringify(binding))
      throw new PrepareFailure("INTEGRITY_INVALID");
    StoreWorkerCodeAuthority.prototype.assertDataNative.call(code, host.native);
    return Object.freeze({
      binding,
      modelFingerprint: Object.freeze(model.fingerprint),
    });
  } catch (error) {
    if (signal.aborted) throw new PrepareFailure("PREPARE_INTERRUPTED");
    throw new PrepareFailure(preparationFailure(error).code, "model");
  }
}
