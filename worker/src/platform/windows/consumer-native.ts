import {
  assertConsumerAbsolutePath,
  assertConsumerNonce,
  assertConsumerPipePeer,
  assertConsumerRelativePath,
  CONSUMER_NATIVE_MAX_PIPE_PAYLOAD,
  CONSUMER_NATIVE_MAX_PIPE_RESPONSE,
  CONSUMER_NATIVE_MAX_SECRET,
  ConsumerNativeError,
  decodeConsumerBase64,
  isLogonSid,
  object,
  processIdentityFromWire,
  processIdentityToWire,
  type ConsumerHostIdentity,
  type ConsumerOwnedProcess,
  type ConsumerOwnedRole,
  type ConsumerMutexLease,
  type ConsumerMutexScope,
  type ConsumerPipeConnection,
  type ConsumerProcessIdentity,
  type ConsumerRoot,
  type ConsumerVaultNamespace,
} from "./consumer-native-policy.js";
import type { ConsumerNativeTransport } from "./consumer-native-transport.js";
import type { ConsumerNativeEvent } from "./consumer-native-events.js";
import {
  parseStoreCpuOperationExpectation,
  type StoreCpuOperationExpectation,
} from "./consumer-store-cpu.js";
import {
  openConsumerPrivateFile,
  openConsumerStoreFixtureFile,
  openConsumerStoreModelFile,
  recoverConsumerStoreModelPublication,
  type StoreModelWritable,
  type PrivateFileMode,
  type PrivateReadable,
  type PrivateWritable,
} from "./consumer-private-file.js";
import {
  shareCleanupFileToWire,
  parsePersonalCleanupState,
  parseStorageCleanupReceipt,
  type ConsumerShareCleanupFile,
  type ConsumerStorageCleanupReceipt,
  type ConsumerLibraryCleanup,
} from "./consumer-native-cleanup.js";
import {
  createdExportDiscardToWire,
  parseExportDiscardResult,
  assertExportDiscardRequestId,
  type ConsumerCreatedExportDiscard,
  type ConsumerExportDiscardResult,
} from "./consumer-native-export.js";
import { randomUUID } from "node:crypto";
import {
  assertCacheDeletionPath,
  cacheIdentityToWire,
  cacheDeletionToWire,
  parseCacheDeletion,
  type ConsumerFileBirth,
  type ConsumerCacheFileIdentity,
  type ConsumerCacheDeletion,
} from "./consumer-native-cache.js";
import {
  consumerShareArgs,
  assertShareRequestId,
  parseConsumerShareReceipt,
  type ConsumerShareSource,
  type ConsumerShareReceipt,
} from "./consumer-native-share.js";
import {
  consumerInstallerArgs,
  parseConsumerInstallerLaunch,
  type ConsumerInstallerPin,
  type ConsumerInstallerLaunchStatus,
} from "./consumer-native-installer.js";
import {
  parseConsumerGpu,
  parseConsumerGpuLease,
  type ConsumerGpuIdentity,
  type ConsumerGpuLease,
} from "./consumer-native-gpu.js";

export * from "./consumer-native-policy.js";
export * from "./consumer-native-transport.js";
export * from "./consumer-native-events.js";
export * from "./consumer-private-file.js";
export * from "./consumer-native-gpu.js";
export * from "./consumer-native-installer.js";
export * from "./consumer-native-share.js";
export * from "./consumer-native-cache.js";
export * from "./consumer-native-export.js";
export * from "./consumer-native-cleanup.js";
export * from "./consumer-store-cpu.js";

export interface ConsumerLaunchVerifier {
  /** Check signed windows-user inventory, active release, leases and fixed entry. */
  verify(role: ConsumerOwnedRole, release: string): Promise<void>;
}
export interface ConsumerAccountAppPin {
  sha256: string;
  bytes: number;
  publisherSha256: string;
}
export type ConsumerSingletonScope = "session" | "account";
export type ConsumerSingletonOwner =
  | { state: "absent"; owner: null; sameSession: false }
  | { state: "active"; owner: ConsumerProcessIdentity; sameSession: boolean };

export class WindowsConsumerNative {
  #storeCpuAcknowledgements = new Map<
    string,
    {
      binding: string;
      ackNonce: string | undefined;
      pending: Promise<void> | undefined;
    }
  >();
  openStoreModelFile(
    expectedBirth?: ConsumerFileBirth,
  ): Promise<StoreModelWritable> {
    return openConsumerStoreModelFile(this.transport, expectedBirth);
  }
  recoverStoreModelPublication() {
    return recoverConsumerStoreModelPublication(this.transport);
  }
  openStoreFixtureFile(
    relative: string,
    maximumBytes: number,
    expectedBirth?: ConsumerFileBirth,
  ): Promise<PrivateWritable> {
    return openConsumerStoreFixtureFile(
      this.transport,
      relative,
      maximumBytes,
      expectedBirth,
    );
  }
  openPrivateFile(
    relativePath: string,
    mode: "read",
    maximumBytes: number,
  ): Promise<PrivateReadable | null>;
  openPrivateFile(
    relativePath: string,
    mode: "create-new" | "resume",
    maximumBytes: number,
    expectedBirth?: ConsumerFileBirth,
  ): Promise<PrivateWritable>;
  async openPrivateFile(
    relativePath: string,
    mode: PrivateFileMode,
    maximumBytes: number,
    expectedBirth?: ConsumerFileBirth,
  ): Promise<PrivateReadable | PrivateWritable | null> {
    return openConsumerPrivateFile(
      this.transport,
      relativePath,
      mode,
      maximumBytes,
      expectedBirth,
    );
  }
  async discardStoragePartial(
    requestId: string,
  ): Promise<ConsumerStorageCleanupReceipt> {
    assertExportDiscardRequestId(requestId);
    const lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    return parseStorageCleanupReceipt(
      await this.transport.request(
        "storage_partial_discard",
        { request_id: requestId, cache_nonce: lease.nonce },
        35000,
      ),
    );
  }
  /** Only the exact private write/publication row may retire its created Library leaf. */
  async discardLibraryArtifact(
    writeId: string,
    relativePath: string,
    identity: ConsumerCacheFileIdentity,
  ): Promise<ConsumerStorageCleanupReceipt> {
    assertExportDiscardRequestId(writeId);
    if (
      !/^library\\media\\[a-f0-9]{64}\\[a-f0-9]{24}\\(?:voice|original)\\[a-f0-9]{64}\\(?:media\.(?:mp3|m4a|mp4|webm|opus|ogg|aac|wav|flac)(?:\.[a-f0-9-]{36}\.part)?|media\.json(?:\.[a-f0-9-]{36}\.tmp)?)$/u.test(
        relativePath,
      )
    )
      throw new ConsumerNativeError("BAD_REQUEST");
    const lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    return parseStorageCleanupReceipt(
      await this.transport.request(
        "library_artifact_discard",
        {
          request_id: writeId,
          relative_path: relativePath,
          expected: cacheIdentityToWire(identity, "file"),
          cache_nonce: lease.nonce,
        },
        35000,
      ),
    );
  }
  /** Closed account job cache or protected local tombstone, never arbitrary trees. */
  async discardLibraryTree(
    relativePath: string,
    birth: ConsumerFileBirth,
    deletionId: string | null,
  ): Promise<ConsumerStorageCleanupReceipt> {
    assertConsumerRelativePath(relativePath);
    if (deletionId === null) {
      if (!/^library\\media\\[a-f0-9]{64}\\[a-f0-9]{24}$/u.test(relativePath))
        throw new ConsumerNativeError("BAD_REQUEST");
    } else {
      assertExportDiscardRequestId(deletionId);
      if (
        !new RegExp(
          `^personal\\\\results\\\\[a-f0-9-]{36}\\.${deletionId}\\.deleted$`,
          "u",
        ).test(relativePath)
      )
        throw new ConsumerNativeError("BAD_REQUEST");
    }
    const lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    return parseStorageCleanupReceipt(
      await this.transport.request(
        "library_tree_discard",
        {
          relative_path: relativePath,
          birth: cacheIdentityToWire(birth, "directory"),
          deletion_id: deletionId,
          cache_nonce: lease.nonce,
        },
        35000,
      ),
    );
  }
  async acknowledgeLibraryTreeCleanup(
    receipt: Extract<ConsumerStorageCleanupReceipt, { state: "completed" }>,
  ): Promise<void> {
    assertConsumerNonce(receipt.receiptId);
    assertConsumerNonce(receipt.nonce);
    const lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    const row = object(
      await this.transport.request(
        "library_tree_cleanup_ack",
        {
          receipt_id: receipt.receiptId,
          nonce: receipt.nonce,
          cache_nonce: lease.nonce,
        },
        35000,
      ),
    );
    if (Object.keys(row).join() !== "acknowledged" || row.acknowledged !== true)
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  }
  async listLibraryCleanups(): Promise<ConsumerLibraryCleanup[]> {
    const lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    const row = object(
      await this.transport.request(
        "library_tree_cleanup_list",
        { cache_nonce: lease.nonce },
        35000,
      ),
    );
    if (
      Object.keys(row).join() !== "entries" ||
      !Array.isArray(row.entries) ||
      row.entries.length > 16
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return row.entries.map((value) => {
      const item = object(value),
        birth = object(item.birth);
      if (
        Object.keys(item).sort().join() !==
          "birth,deletion_id,receipt,relative_path" ||
        typeof item.relative_path !== "string" ||
        Object.keys(birth).sort().join() !== "born_at,device,file_id"
      )
        throw new ConsumerNativeError("PROTOCOL_MISMATCH");
      const result: ConsumerLibraryCleanup = {
        relativePath: item.relative_path,
        birth: {
          device: birth.device as string,
          fileId: birth.file_id as string,
          bornAt: birth.born_at as string,
        },
        deletionId: item.deletion_id as string | null,
        receipt: null,
      };
      cacheIdentityToWire(result.birth, "directory");
      if (result.deletionId === null) {
        if (
          !/^library\\media\\[a-f0-9]{64}\\[a-f0-9]{24}$/u.test(
            result.relativePath,
          )
        )
          throw new ConsumerNativeError("PROTOCOL_MISMATCH");
      } else {
        if (typeof result.deletionId !== "string")
          throw new ConsumerNativeError("PROTOCOL_MISMATCH");
        assertExportDiscardRequestId(result.deletionId);
        if (
          !new RegExp(
            `^personal\\\\results\\\\[a-f0-9-]{36}\\.${result.deletionId}\\.deleted$`,
            "u",
          ).test(result.relativePath)
        )
          throw new ConsumerNativeError("PROTOCOL_MISMATCH");
      }
      if (item.receipt !== null) {
        const receipt = parseStorageCleanupReceipt(item.receipt);
        if (receipt.state !== "completed")
          throw new ConsumerNativeError("PROTOCOL_MISMATCH");
        result.receipt = receipt;
      }
      return result;
    });
  }
  async moveLocalLibraryDeletion(
    deletionId: string,
    direction: "tombstone" | "restore",
  ): Promise<void> {
    assertExportDiscardRequestId(deletionId);
    if (direction !== "tombstone" && direction !== "restore")
      throw new ConsumerNativeError("BAD_REQUEST");
    const lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    const row = object(
      await this.transport.request(
        "library_local_move",
        { request_id: deletionId, direction, cache_nonce: lease.nonce },
        35000,
      ),
    );
    if (Object.keys(row).join() !== "moved" || row.moved !== true)
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  }
  async publishLibraryArtifact(
    writeId: string,
    component: "media" | "metadata",
  ): Promise<void> {
    assertExportDiscardRequestId(writeId);
    if (component !== "media" && component !== "metadata")
      throw new ConsumerNativeError("BAD_REQUEST");
    const lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    const row = object(
      await this.transport.request(
        "library_artifact_publish",
        { request_id: writeId, component, cache_nonce: lease.nonce },
        35000,
      ),
    );
    if (Object.keys(row).join() !== "moved" || row.moved !== true)
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  }
  async inspectLibraryArtifactPublication(
    writeId: string,
    component: "media" | "metadata",
  ): Promise<{ relativePath: string; identity: ConsumerCacheFileIdentity }> {
    assertExportDiscardRequestId(writeId);
    if (component !== "media" && component !== "metadata")
      throw new ConsumerNativeError("BAD_REQUEST");
    const lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    const row = object(
        await this.transport.request(
          "library_artifact_publication_inspect",
          { request_id: writeId, component, cache_nonce: lease.nonce },
          35000,
        ),
      ),
      wire = object(row.identity);
    if (
      Object.keys(row).sort().join() !== "identity,relative_path" ||
      typeof row.relative_path !== "string" ||
      Object.keys(wire).sort().join() !==
        "born_at,bytes,changed_at,device,file_id,written_at"
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    assertCacheDeletionPath(row.relative_path);
    const identity: ConsumerCacheFileIdentity = {
      device: wire.device as string,
      fileId: wire.file_id as string,
      bornAt: wire.born_at as string,
      bytes: wire.bytes as number,
      writtenAt: wire.written_at as string,
      changedAt: wire.changed_at as string,
    };
    cacheIdentityToWire(identity, "file");
    return { relativePath: row.relative_path, identity };
  }
  async retireStorageWorkspaceMarker(
    relativePath: string,
    owner: ConsumerOwnedProcess,
  ): Promise<ConsumerStorageCleanupReceipt> {
    assertConsumerRelativePath(relativePath);
    assertConsumerNonce(owner.nonce);
    if (
      !/^(?:personal\\(?:jobs|inputs|engine-session)|cloud\\work|prepare\\(?:work|downloads))\\[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
        relativePath,
      )
    )
      throw new ConsumerNativeError("BAD_REQUEST");
    const lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    return parseStorageCleanupReceipt(
      await this.transport.request(
        "storage_workspace_marker_retire",
        {
          relative_path: relativePath,
          owner: {
            role: owner.role,
            nonce: owner.nonce,
            identity: processIdentityToWire(owner.identity),
          },
          cache_nonce: lease.nonce,
        },
        35000,
      ),
    );
  }
  /** A received expectation grants nothing: the Store helper must query the
   * exact original Creator row before retiring its held workspace marker. */
  async inspectStoreCpuOperation(
    expectation: StoreCpuOperationExpectation,
  ): Promise<boolean> {
    if (arguments.length !== 1) throw new ConsumerNativeError("BAD_REQUEST");
    const result = object(
      await this.transport.request(
        "store_cpu_operation_cleanup_inspect",
        {
          expectation: parseStoreCpuOperationExpectation(expectation),
        },
        35000,
      ),
    );
    if (
      Object.keys(result).join() !== "retired" ||
      typeof result.retired !== "boolean"
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return result.retired;
  }
  async retireStoreCpuWorkspaceMarker(
    relativePath: string,
    expectation: StoreCpuOperationExpectation,
  ): Promise<ConsumerStorageCleanupReceipt> {
    const received = parseStoreCpuOperationExpectation(expectation),
      expected = `${received.operation === "silence_analyze" ? "prepare" : "cloud"}\\work\\${received.requestId}`;
    if (arguments.length !== 2 || relativePath !== expected)
      throw new ConsumerNativeError("BAD_REQUEST");
    const lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    return parseStorageCleanupReceipt(
      await this.transport.request(
        "store_cpu_workspace_marker_retire",
        {
          relative_path: relativePath,
          expectation: received,
          cache_nonce: lease.nonce,
        },
        35000,
      ),
    );
  }
  async acknowledgeStoreCpuWorkspaceMarker(
    receipt: Extract<ConsumerStorageCleanupReceipt, { state: "completed" }>,
    expectation: StoreCpuOperationExpectation,
  ): Promise<void> {
    if (arguments.length !== 2) throw new ConsumerNativeError("BAD_REQUEST");
    const receiptId = receipt.receiptId,
      nonce = receipt.nonce;
    assertConsumerNonce(receiptId);
    assertConsumerNonce(nonce);
    const received = parseStoreCpuOperationExpectation(expectation),
      lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    const binding = JSON.stringify({
      nonce: nonce,
      expectation: received,
    });
    let entry = this.#storeCpuAcknowledgements.get(receiptId);
    if (entry && entry.binding !== binding)
      throw new ConsumerNativeError("PEER_DENIED");
    if (!entry) {
      if (this.#storeCpuAcknowledgements.size >= 256)
        throw new ConsumerNativeError("VAULT_RECOVERY_REQUIRED");
      entry = { binding, ackNonce: undefined, pending: undefined };
      this.#storeCpuAcknowledgements.set(receiptId, entry);
    }
    if (entry.pending) return entry.pending;
    const retained = entry;
    const task = (async () => {
      const args = {
        receipt_id: receiptId,
        nonce: nonce,
        expectation: received,
        cache_nonce: lease.nonce,
      };
      if (!retained.ackNonce) {
        const result = object(
          await this.transport.request(
            "store_cpu_workspace_marker_acknowledge",
            args,
            35000,
          ),
        );
        if (
          Object.keys(result).sort().join() !== "ack_nonce,acknowledged" ||
          result.acknowledged !== true ||
          typeof result.ack_nonce !== "string" ||
          !/^[a-f0-9]{64}$/u.test(result.ack_nonce)
        )
          throw new ConsumerNativeError("PROTOCOL_MISMATCH");
        // Retain the original positive receipt before attempting collection.
        // A lost release reply retries collection, never the byte effects.
        retained.ackNonce = result.ack_nonce;
      }
      if (this.ownedMutexes.get("cache") !== lease)
        throw new ConsumerNativeError("PEER_DENIED");
      const result = object(
        await this.transport.request(
          "store_cpu_workspace_marker_release",
          { ...args, ack_nonce: retained.ackNonce },
          35000,
        ),
      );
      if (Object.keys(result).join() !== "released" || result.released !== true)
        throw new ConsumerNativeError("PROTOCOL_MISMATCH");
      this.#storeCpuAcknowledgements.delete(receiptId);
    })();
    retained.pending = task;
    try {
      await task;
    } finally {
      if (retained.pending === task) retained.pending = undefined;
    }
  }
  async acknowledgeStorageCleanup(
    receipt: Extract<ConsumerStorageCleanupReceipt, { state: "completed" }>,
  ): Promise<void> {
    assertConsumerNonce(receipt.receiptId);
    assertConsumerNonce(receipt.nonce);
    const lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    const result = object(
      await this.transport.request(
        "storage_cleanup_ack",
        {
          receipt_id: receipt.receiptId,
          nonce: receipt.nonce,
          cache_nonce: lease.nonce,
        },
        35000,
      ),
    );
    if (
      Object.keys(result).join() !== "acknowledged" ||
      result.acknowledged !== true
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  }
  /** Metadata-only recovery: a durable submitted disposition may complete;
   * an uncertain pre-effect intent never becomes success from path absence. */
  async recoverStorageCleanups(): Promise<{ retained: number }> {
    const lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    const row = object(
      await this.transport.request(
        "storage_cleanup_recover",
        { cache_nonce: lease.nonce },
        35000,
      ),
    );
    if (
      Object.keys(row).join() !== "retained" ||
      !Number.isSafeInteger(row.retained) ||
      (row.retained as number) < 0 ||
      (row.retained as number) > 256
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return { retained: row.retained as number };
  }
  /** Exact Share write-journal and terminal OS authority; separate from eviction. */
  async discardShareWorkspace(
    requestId: string,
    birth: ConsumerFileBirth,
    file: ConsumerShareCleanupFile | null,
  ): Promise<"completed" | "pending"> {
    const lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    assertExportDiscardRequestId(requestId);
    return parsePersonalCleanupState(
      await this.transport.request(
        "share_workspace_discard",
        {
          request_id: requestId,
          birth: cacheIdentityToWire(birth, "directory"),
          file: shareCleanupFileToWire(requestId, file),
          cache_nonce: lease.nonce,
        },
        35000,
      ),
    );
  }
  /** Only an exact DPAPI deleting diagnostic row authorizes the native leaf. */
  async removeChromeDiagnosticReport(
    receipt: string,
  ): Promise<"completed" | "pending"> {
    const lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    assertExportDiscardRequestId(receipt);
    return parsePersonalCleanupState(
      await this.transport.request(
        "diagnostic_report_remove",
        { request_id: receipt, cache_nonce: lease.nonce },
        35000,
      ),
    );
  }
  /** Bounded completed-receipt retirement; never initiates a data deletion. */
  async recoverPersonalCleanups(): Promise<{
    removed: number;
    retained: number;
  }> {
    const lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    const row = object(
      await this.transport.request(
        "personal_cleanup_recover",
        { cache_nonce: lease.nonce },
        35000,
      ),
    );
    if (
      Object.keys(row).sort().join() !== "removed,retained" ||
      !Number.isInteger(row.removed) ||
      !Number.isInteger(row.retained) ||
      (row.removed as number) < 0 ||
      (row.retained as number) < 0 ||
      (row.removed as number) + (row.retained as number) > 20
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return { removed: row.removed as number, retained: row.retained as number };
  }
  /** Main-only preflight before an exclusive create; never creates or removes a leaf. */
  async validateExportDestination(
    path: string,
    pin: ConsumerAccountAppPin,
  ): Promise<void> {
    assertConsumerAbsolutePath(path);
    const row = object(
      await this.transport.request(
        "created_export_destination_validate",
        {
          path,
          ...this.accountAppArgs(pin),
        },
        35000,
      ),
    );
    if (Object.keys(row).join() !== "validated" || row.validated !== true)
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  }
  /** One fixed user-requested Setup action; no URL/executable/argument parameter. */
  async openChromeExtensions(pin: ConsumerAccountAppPin): Promise<void> {
    const row = object(
      await this.transport.request(
        "chrome_extensions_open",
        this.accountAppArgs(pin),
        35000,
      ),
    );
    if (Object.keys(row).join() !== "started" || row.started !== true)
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  }
  /** Main-private exclusively created save destination, never a renderer path. */
  async discardCreatedExport(
    request: ConsumerCreatedExportDiscard,
    pin: ConsumerAccountAppPin,
  ): Promise<ConsumerExportDiscardResult> {
    const own = await this.identity();
    if (
      request.creator.sid !== own.sid ||
      request.creator.sessionId !== own.sessionId ||
      request.creator.pid === own.pid
    )
      throw new ConsumerNativeError("PEER_DENIED");
    return parseExportDiscardResult(
      await this.transport.request(
        "created_export_discard",
        { ...createdExportDiscardToWire(request), ...this.accountAppArgs(pin) },
        35000,
      ),
      request.requestId,
    );
  }
  async inspectCreatedExportDiscard(
    requestId: string,
    pin: ConsumerAccountAppPin,
  ): Promise<ConsumerExportDiscardResult | { state: "absent" }> {
    assertExportDiscardRequestId(requestId);
    const value = await this.transport.request(
        "created_export_discard_inspect",
        { request_id: requestId, ...this.accountAppArgs(pin) },
        35000,
      ),
      row = object(value);
    if (row.state === "absent" && Object.keys(row).join() === "state")
      return { state: "absent" };
    return parseExportDiscardResult(row, requestId);
  }
  /** Receipt retirement only. A successful ACK is never file-deletion proof. */
  async acknowledgeCreatedExportDiscard(
    requestId: string,
    nonce: string,
    pin: ConsumerAccountAppPin,
  ): Promise<void> {
    assertExportDiscardRequestId(requestId);
    assertConsumerNonce(nonce);
    const row = object(
      await this.transport.request(
        "created_export_discard_ack",
        { request_id: requestId, nonce, ...this.accountAppArgs(pin) },
        35000,
      ),
    );
    if (Object.keys(row).join() !== "acknowledged" || row.acknowledged !== true)
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  }
  /** Fixed Prepare quarantine only. recordDigest hashes exact DPAPI plaintext
   * bytes, not a parsed/reserialized object. This cannot grant GPU inference. */
  async removeRuntimeRepairBackup(
    target: string,
    recordDigest: string,
  ): Promise<{ state: "completed" | "pending" }> {
    this.assertDigest(target);
    this.assertDigest(recordDigest);
    const lease = this.ownedMutexes.get("prepare");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    const row = object(
      await this.transport.request(
        "runtime_repair_backup_remove",
        { target, record_digest: recordDigest, prepare_nonce: lease.nonce },
        35000,
      ),
    );
    if (
      Object.keys(row).join() !== "state" ||
      (row.state !== "completed" && row.state !== "pending")
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return { state: row.state };
  }
  async beginCacheDeletion(
    relativePath: string,
    kind: "file" | "directory",
    expected: ConsumerFileBirth | ConsumerCacheFileIdentity,
  ): Promise<ConsumerCacheDeletion | null> {
    const lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    assertCacheDeletionPath(relativePath);
    const requestId = randomUUID();
    const result = await this.transport.request("cache_delete_begin", {
      request_id: requestId,
      relative_path: relativePath,
      kind,
      expected: cacheIdentityToWire(expected, kind),
      cache_nonce: lease.nonce,
    });
    if (result === null) return null;
    const candidate = parseCacheDeletion(result);
    if (
      candidate.requestId !== requestId ||
      candidate.relativePath !== relativePath ||
      candidate.kind !== kind
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return candidate;
  }
  async commitCacheDeletion(
    candidate: ConsumerCacheDeletion,
  ): Promise<"completed" | "pending"> {
    const lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    const row = object(
      await this.transport.request("cache_delete_commit", {
        ...cacheDeletionToWire(candidate),
        cache_nonce: lease.nonce,
      }),
    );
    if (
      Object.keys(row).join() !== "state" ||
      (row.state !== "completed" && row.state !== "pending")
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return row.state;
  }
  async releaseCacheDeletion(candidate: ConsumerCacheDeletion): Promise<void> {
    const lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    const row = object(
      await this.transport.request("cache_delete_release", {
        ...cacheDeletionToWire(candidate),
        cache_nonce: lease.nonce,
      }),
    );
    if (Object.keys(row).join() !== "released" || row.released !== true)
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  }
  async recoverCacheDeletions(): Promise<{
    completed: number;
    pending: number;
  }> {
    const lease = this.ownedMutexes.get("cache");
    if (!lease) throw new ConsumerNativeError("PEER_DENIED");
    const row = object(
      await this.transport.request("cache_delete_recover", {
        cache_nonce: lease.nonce,
      }),
    );
    if (
      Object.keys(row).sort().join() !== "completed,pending" ||
      ![row.completed, row.pending].every(
        (n) => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 16,
      )
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return {
      completed: row.completed as number,
      pending: row.pending as number,
    };
  }
  async retainSessionLauncher(
    sha256: string,
    publisherSha256: string,
  ): Promise<void> {
    this.assertDigest(sha256);
    this.assertDigest(publisherSha256);
    const row = object(
      await this.transport.request("startup_retain", {
        launcher_sha256: sha256,
        publisher_sha256: publisherSha256,
      }),
    );
    if (Object.keys(row).join() !== "retained" || row.retained !== true)
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  }
  /** Exact native helper -> Node -> retained signed shim lineage, all current SID/logon/birth bound. */
  async verifyWorkerLoginPeer(): Promise<{
    release: string;
    capsuleSha256: string;
    launcherSha256: string;
    resourcesRoot: string;
  }> {
    const row = object(
      await this.transport.request("worker_login_peer_verify", {}),
    );
    if (
      Object.keys(row).sort().join() !==
        "capsule_sha256,launcher_sha256,release,resources_root,verified" ||
      row.verified !== true
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    for (const key of ["release", "capsule_sha256", "launcher_sha256"]) {
      if (typeof row[key] !== "string")
        throw new ConsumerNativeError("PROTOCOL_MISMATCH");
      this.assertDigest(row[key] as string);
    }
    if (typeof row.resources_root !== "string")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    assertConsumerAbsolutePath(row.resources_root);
    return {
      release: row.release as string,
      capsuleSha256: row.capsule_sha256 as string,
      launcherSha256: row.launcher_sha256 as string,
      resourcesRoot: row.resources_root as string,
    };
  }
  /** Positive protected certificates for the latest exact personal/fleet/Prepare role trees. */
  async workerLoginIdle(
    scope: "session" | "prepare" = "session",
  ): Promise<boolean> {
    if (scope !== "session" && scope !== "prepare")
      throw new ConsumerNativeError("BAD_REQUEST");
    const row = object(
      await this.transport.request("worker_login_idle", { scope }),
    );
    if (Object.keys(row).join() !== "idle" || typeof row.idle !== "boolean")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return row.idle;
  }
  /** App-owned volatile reboot witness. Hive unload may invalidate it earlier. */
  async bootIdentity(): Promise<string> {
    const row = object(await this.transport.request("boot_identity", {}));
    if (
      Object.keys(row).sort().join() !== "boot_id,source" ||
      row.source !== "volatile-registry-witness-v1" ||
      typeof row.boot_id !== "string" ||
      !/^[a-f0-9]{64}$/u.test(row.boot_id)
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return row.boot_id;
  }
  async acknowledgeShareCleanup(
    lease: Pick<ConsumerShareReceipt, "requestId" | "nonce">,
  ): Promise<boolean> {
    assertShareRequestId(lease.requestId);
    assertConsumerNonce(lease.nonce);
    const row = object(
      await this.transport.request(
        "share_cleanup_acknowledge",
        { request_id: lease.requestId, nonce: lease.nonce },
        35000,
      ),
    );
    if (
      Object.keys(row).join() !== "removed" ||
      typeof row.removed !== "boolean"
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return row.removed;
  }
  async pruneCompletedShareReceipts(): Promise<{
    removed: number;
    retained: number;
  }> {
    const row = object(
      await this.transport.request("share_cleanup_completed", {}, 35000),
    );
    if (
      Object.keys(row).sort().join() !== "removed,retained" ||
      !Number.isInteger(row.removed) ||
      (row.removed as number) < 0 ||
      (row.removed as number) > 16 ||
      !Number.isInteger(row.retained) ||
      (row.retained as number) < 0 ||
      (row.retained as number) > 64
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return { removed: row.removed as number, retained: row.retained as number };
  }
  async startShare(
    source: ConsumerShareSource,
    pin: ConsumerAccountAppPin,
  ): Promise<ConsumerShareReceipt> {
    const own = await this.identity();
    if (
      source.windowOwner.sid !== own.sid ||
      source.windowOwner.sessionId !== own.sessionId
    )
      throw new ConsumerNativeError("PEER_DENIED");
    const receipt = parseConsumerShareReceipt(
      await this.transport.request(
        "share_start",
        { ...consumerShareArgs(source), ...this.accountAppArgs(pin) },
        35000,
      ),
    );
    if (
      receipt.requestId !== source.requestId ||
      receipt.relativePath !== source.relativePath ||
      receipt.sha256 !== source.sha256 ||
      receipt.bytes !== source.bytes ||
      receipt.windowOwner.pid !== source.windowOwner.pid ||
      receipt.windowOwner.creationTime !== source.windowOwner.creationTime ||
      receipt.windowOwner.sid !== own.sid ||
      receipt.windowOwner.sessionId !== own.sessionId ||
      receipt.helper.pid !== own.pid ||
      receipt.helper.creationTime !== own.creationTime
    )
      throw new ConsumerNativeError("PEER_DENIED");
    return receipt;
  }
  async inspectShare(requestId: string): Promise<ConsumerShareReceipt | null> {
    assertShareRequestId(requestId);
    const value = await this.transport.request(
      "share_inspect",
      { request_id: requestId },
      35000,
    );
    if (value === null) return null;
    const receipt = parseConsumerShareReceipt(value),
      own = await this.identity();
    if (receipt.requestId !== requestId || receipt.windowOwner.sid !== own.sid)
      throw new ConsumerNativeError("PEER_DENIED");
    return receipt;
  }
  async cancelShare(
    lease: Pick<ConsumerShareReceipt, "requestId" | "nonce">,
  ): Promise<ConsumerShareReceipt> {
    assertShareRequestId(lease.requestId);
    assertConsumerNonce(lease.nonce);
    const receipt = parseConsumerShareReceipt(
      await this.transport.request(
        "share_cancel",
        { request_id: lease.requestId, nonce: lease.nonce },
        35000,
      ),
    );
    const own = await this.identity();
    if (
      receipt.requestId !== lease.requestId ||
      receipt.nonce !== lease.nonce ||
      receipt.windowOwner.sid !== own.sid
    )
      throw new ConsumerNativeError("PEER_DENIED");
    return receipt;
  }
  async registerProtocol(): Promise<void> {
    const row = object(await this.transport.request("protocol_register", {}));
    if (Object.keys(row).join() !== "registered" || row.registered !== true)
      throw new ConsumerNativeError("PROTOCOL_REGISTRATION_CONFLICT");
  }
  async unregisterProtocol(): Promise<void> {
    const row = object(await this.transport.request("protocol_unregister", {}));
    if (Object.keys(row).join() !== "removed" || row.removed !== true)
      throw new ConsumerNativeError("PROTOCOL_REGISTRATION_CONFLICT");
  }
  async verifyInstallerMaintenancePeer(
    peer: ConsumerProcessIdentity,
    action: "install" | "uninstall",
    pin: ConsumerAccountAppPin,
  ): Promise<{
    issuer: ConsumerProcessIdentity;
    certificateNonce: string | null;
  }> {
    if (action !== "install" && action !== "uninstall")
      throw new ConsumerNativeError("BAD_REQUEST");
    const own = await this.identity();
    if (peer.sid !== own.sid || peer.sessionId !== own.sessionId)
      throw new ConsumerNativeError("PEER_DENIED");
    const row = object(
      await this.transport.request(
        "installer_maintenance_peer_verify",
        {
          ...this.accountAppArgs(pin),
          identity: processIdentityToWire(peer),
          action,
        },
        35000,
      ),
    );
    if (
      Object.keys(row).sort().join() !==
        "authorized,certificate_nonce,issuer" ||
      row.authorized !== true ||
      (row.certificate_nonce !== null &&
        typeof row.certificate_nonce !== "string")
    )
      throw new ConsumerNativeError("PEER_DENIED");
    if (row.certificate_nonce !== null)
      assertConsumerNonce(row.certificate_nonce as string);
    const issuer = processIdentityFromWire(row.issuer);
    if (issuer.sid !== own.sid || issuer.sessionId !== own.sessionId)
      throw new ConsumerNativeError("PEER_DENIED");
    return { issuer, certificateNonce: row.certificate_nonce as string | null };
  }
  async verifyPersonalOwnerProofPeers(
    authority: ConsumerProcessIdentity,
    owner: ConsumerProcessIdentity,
    ownerKind: "desktop" | "chrome",
  ): Promise<boolean> {
    const own = await this.identity();
    if (
      (ownerKind !== "desktop" && ownerKind !== "chrome") ||
      [authority, owner].some(
        (peer) => peer.sid !== own.sid || peer.sessionId !== own.sessionId,
      )
    )
      throw new ConsumerNativeError("PEER_DENIED");
    const row = object(
      await this.transport.request(
        "personal_owner_proof_peers",
        {
          authority: processIdentityToWire(authority),
          owner: processIdentityToWire(owner),
          owner_kind: ownerKind,
        },
        35000,
      ),
    );
    if (typeof row.verified !== "boolean")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return row.verified;
  }
  async verifyBrowserOwnerProofPeers(
    authority: ConsumerProcessIdentity,
    browser: ConsumerProcessIdentity,
  ): Promise<boolean> {
    const own = await this.identity();
    if (
      [authority, browser].some(
        (peer) => peer.sid !== own.sid || peer.sessionId !== own.sessionId,
      )
    )
      throw new ConsumerNativeError("PEER_DENIED");
    const row = object(
      await this.transport.request(
        "browser_owner_proof_peers",
        {
          authority: processIdentityToWire(authority),
          browser: processIdentityToWire(browser),
        },
        35000,
      ),
    );
    if (typeof row.verified !== "boolean")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return row.verified;
  }
  private accountAppArgs(pin: ConsumerAccountAppPin): Record<string, unknown> {
    this.assertDigest(pin.sha256);
    this.assertDigest(pin.publisherSha256);
    if (
      !Number.isSafeInteger(pin.bytes) ||
      pin.bytes < 1 ||
      pin.bytes > 256 * 1024 ** 2
    )
      throw new ConsumerNativeError("BAD_REQUEST");
    return {
      app_sha256: pin.sha256,
      app_bytes: pin.bytes,
      publisher_sha256: pin.publisherSha256,
    };
  }
  /** Fixed signed asInvoker app operation; no caller-controlled path or arguments. */
  async launchAccountAuthority(
    pin: ConsumerAccountAppPin,
  ): Promise<ConsumerProcessIdentity> {
    const row = object(
        await this.transport.request(
          "account_authority_launch",
          this.accountAppArgs(pin),
          35000,
        ),
      ),
      identity = processIdentityFromWire(row.identity),
      own = await this.identity();
    if (identity.sid !== own.sid || identity.sessionId !== own.sessionId)
      throw new ConsumerNativeError("PEER_DENIED");
    return identity;
  }
  async verifyAccountPeer(
    peer: ConsumerProcessIdentity,
    role: "authority" | "browser",
    pin: ConsumerAccountAppPin,
  ): Promise<boolean> {
    if (role !== "authority" && role !== "browser")
      throw new ConsumerNativeError("BAD_REQUEST");
    const own = await this.identity();
    if (peer.sid !== own.sid || peer.sessionId !== own.sessionId)
      throw new ConsumerNativeError("PEER_DENIED");
    const row = object(
      await this.transport.request(
        "account_peer_verify",
        {
          ...this.accountAppArgs(pin),
          identity: processIdentityToWire(peer),
          role,
        },
        35000,
      ),
    );
    if (typeof row.verified !== "boolean")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return row.verified;
  }
  async removeUnusedRelease(
    release: string,
    manifestSha256: string,
  ): Promise<boolean> {
    assertConsumerNonce(release);
    assertConsumerNonce(manifestSha256);
    if (!this.ownedMutexes.has("prepare"))
      throw new ConsumerNativeError("PEER_DENIED");
    const row = object(
      await this.transport.request(
        "release_remove_unused",
        { release, manifest_sha256: manifestSha256 },
        35000,
      ),
    );
    if (typeof row.removed !== "boolean")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return row.removed;
  }
  /** Only a wait for this exact identity. This is not an inference-tree exit proof. */
  async waitProcessExit(
    identity: ConsumerProcessIdentity,
    timeoutMs = 30000,
  ): Promise<boolean> {
    const wire = processIdentityToWire(identity),
      own = await this.identity();
    if (
      identity.sid !== own.sid ||
      identity.sessionId !== own.sessionId ||
      identity.pid === own.pid ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 30000
    )
      throw new ConsumerNativeError("PEER_DENIED");
    const row = object(
      await this.transport.request(
        "wait_process_exit",
        { identity: wire, timeout_ms: timeoutMs },
        timeoutMs + 1000,
      ),
    );
    if (typeof row.exited !== "boolean")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return row.exited;
  }
  private installerArgs(pin: ConsumerInstallerPin): Record<string, unknown> {
    return consumerInstallerArgs(pin);
  }
  /** Read the protected prior launch; a missing PID can only produce unknown. */
  async inspectInstallerLaunch(
    pin: ConsumerInstallerPin,
  ): Promise<ConsumerInstallerLaunchStatus> {
    const args = this.installerArgs(pin),
      own = await this.identity();
    return parseConsumerInstallerLaunch(
      await this.transport.request("installer_launch_inspect", args, 35000),
      pin,
      own.sid,
    );
  }
  /** Resume only the exact certified suspended monitor; never creates another installer. */
  async recoverInstallerLaunch(
    pin: ConsumerInstallerPin,
  ): Promise<ConsumerInstallerLaunchStatus> {
    const args = this.installerArgs(pin),
      own = await this.identity();
    return parseConsumerInstallerLaunch(
      await this.transport.request("installer_launch_recover", args, 35000),
      pin,
      own.sid,
    );
  }
  async removeCompletedInstallerMonitor(
    pin: ConsumerInstallerPin,
  ): Promise<boolean> {
    const row = object(
      await this.transport.request(
        "installer_monitor_remove_completed",
        this.installerArgs(pin),
        35000,
      ),
    );
    if (
      Object.keys(row).join() !== "removed" ||
      typeof row.removed !== "boolean"
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return row.removed;
  }
  async verifyInstaller(pin: ConsumerInstallerPin): Promise<void> {
    const args = this.installerArgs(pin);
    await this.identity();
    if (
      object(await this.transport.request("installer_verify", args, 35000))
        .verified !== true
    )
      throw new ConsumerNativeError("HELPER_INTEGRITY_INVALID");
  }
  async launchInstaller(
    pin: ConsumerInstallerPin,
  ): Promise<ConsumerProcessIdentity> {
    const args = this.installerArgs(pin),
      own = await this.identity();
    const row = object(
      await this.transport.request("installer_launch", args, 35000),
    );
    if (row.started !== true) throw new ConsumerNativeError("JOB_UNAVAILABLE");
    const identity = processIdentityFromWire(row.identity);
    if (identity.sid !== own.sid || identity.sessionId !== own.sessionId)
      throw new ConsumerNativeError("PEER_DENIED");
    return identity;
  }
  private readonly usedPipeCapabilities = new Set<string>();
  private readonly usedClientCapabilities = new Set<string>();
  private readonly ownedConnections = new Map<string, ConsumerPipeConnection>();
  private readonly ownedMutexes = new Map<
    ConsumerMutexScope,
    ConsumerMutexLease
  >();
  private readonly ownedGpuGuards = new Map<string, ConsumerGpuLease>();
  constructor(
    private readonly transport: ConsumerNativeTransport,
    private readonly launchVerifier?: ConsumerLaunchVerifier,
  ) {}

  async identity(): Promise<ConsumerHostIdentity> {
    const wire = object(await this.transport.request("identity", {}));
    const identity = processIdentityFromWire(wire);
    if (
      wire.native_arch !== "x64" ||
      wire.process_arch !== "x64" ||
      wire.os_major !== 10 ||
      !Number.isInteger(wire.os_build) ||
      (wire.os_build as number) < 19045
    )
      throw new ConsumerNativeError("UNSUPPORTED_HOST");
    if (!isLogonSid(wire.logon_sid) || typeof wire.local_app_data !== "string")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    assertConsumerAbsolutePath(wire.local_app_data);
    return {
      ...identity,
      logonSid: wire.logon_sid,
      nativeArch: "x64",
      processArch: "x64",
      osMajor: 10,
      osBuild: wire.os_build as number,
      localAppData: wire.local_app_data,
    };
  }

  async processIdentity(pid: number): Promise<ConsumerProcessIdentity | null> {
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647)
      throw new ConsumerNativeError("BAD_REQUEST");
    const result = await this.transport.request("process_identity", { pid });
    if (result === null) return null;
    const identity = processIdentityFromWire(result);
    if (identity.pid !== pid)
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return identity;
  }

  async ensurePrivateDirectory(
    root: ConsumerRoot,
    relativePath = "",
  ): Promise<string> {
    assertConsumerRelativePath(relativePath, true);
    const result = object(
      await this.transport.request("ensure_private_directory", {
        root,
        relative_path: relativePath,
      }),
    );
    if (typeof result.path !== "string")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    assertConsumerAbsolutePath(result.path);
    return result.path;
  }

  async validatePath(
    root: ConsumerRoot,
    relativePath: string,
    kind: "file" | "directory" | "absent",
  ): Promise<void> {
    assertConsumerRelativePath(relativePath, kind === "directory");
    const result = object(
      await this.transport.request("validate_path", {
        root,
        relative_path: relativePath,
        kind,
      }),
    );
    if (result.safe !== true) throw new ConsumerNativeError("PATH_UNSAFE");
  }

  async vaultRead(
    namespace: ConsumerVaultNamespace,
    key: string,
  ): Promise<Buffer | null> {
    this.assertVaultKey(key);
    const result = await this.transport.request("vault_get", {
      namespace,
      key,
    });
    if (result === null) return null;
    const record = object(result);
    if (record.version !== 1) throw new ConsumerNativeError("VAULT_CORRUPT");
    try {
      const bytes = decodeConsumerBase64(
        record.bytes_base64,
        CONSUMER_NATIVE_MAX_SECRET,
      );
      if (bytes.byteLength === 0)
        throw new ConsumerNativeError("VAULT_CORRUPT");
      return bytes;
    } catch {
      throw new ConsumerNativeError("VAULT_CORRUPT");
    }
  }

  async vaultWrite(
    namespace: ConsumerVaultNamespace,
    key: string,
    bytes: Uint8Array,
  ): Promise<void> {
    this.assertVaultKey(key);
    if (bytes.byteLength === 0 || bytes.byteLength > CONSUMER_NATIVE_MAX_SECRET)
      throw new ConsumerNativeError("BAD_REQUEST");
    const result = object(
      await this.transport.request("vault_put", {
        namespace,
        key,
        bytes_base64: Buffer.from(bytes).toString("base64"),
      }),
    );
    if (result.version !== 1 || result.stored !== true)
      throw new ConsumerNativeError("VAULT_UNAVAILABLE");
  }

  async vaultDelete(
    namespace: ConsumerVaultNamespace,
    key: string,
  ): Promise<void> {
    this.assertVaultKey(key);
    const result = object(
      await this.transport.request("vault_delete", { namespace, key }),
    );
    if (result.deleted !== true)
      throw new ConsumerNativeError("VAULT_UNAVAILABLE");
  }

  /** Explicit repair only; scans at most sixteen stale encrypted staging files. */
  async vaultRecover(
    namespace: ConsumerVaultNamespace,
  ): Promise<{ removed: number; skipped: number; limited: boolean }> {
    const result = object(
      await this.transport.request("vault_recover", { namespace }),
    );
    if (
      !Number.isInteger(result.removed) ||
      !Number.isInteger(result.skipped) ||
      (result.removed as number) < 0 ||
      (result.skipped as number) < 0 ||
      (result.removed as number) + (result.skipped as number) > 16 ||
      typeof result.limited !== "boolean"
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return {
      removed: result.removed as number,
      skipped: result.skipped as number,
      limited: result.limited,
    };
  }

  async launchOwned(
    role: ConsumerOwnedRole,
    release: string,
  ): Promise<ConsumerOwnedProcess> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(release))
      throw new ConsumerNativeError("BAD_REQUEST");
    if (!this.launchVerifier)
      throw new ConsumerNativeError("LAUNCH_VERIFICATION_REQUIRED");
    await this.launchVerifier.verify(role, release);
    const owner = await this.identity();
    const result = object(
      await this.transport.request("launch_owned", { role, release }),
    );
    if (result.role !== role || typeof result.nonce !== "string")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    assertConsumerNonce(result.nonce);
    const identity = processIdentityFromWire(result.identity);
    if (identity.sid !== owner.sid || identity.sessionId !== owner.sessionId)
      throw new ConsumerNativeError("JOB_NOT_OWNED");
    return { role, nonce: result.nonce, identity };
  }

  async stopOwned(process: ConsumerOwnedProcess): Promise<void> {
    assertConsumerNonce(process.nonce);
    const result = object(
      await this.transport.request(
        "stop_owned",
        {
          role: process.role,
          nonce: process.nonce,
          identity: processIdentityToWire(process.identity),
        },
        15_000,
      ),
    );
    if (result.stopped !== true)
      throw new ConsumerNativeError("JOB_UNAVAILABLE");
  }
  /** Durable native certificate is written only after the exact Job reports no processes. */
  async ownedTreeExited(owner: ConsumerOwnedProcess): Promise<boolean> {
    assertConsumerNonce(owner.nonce);
    const result = object(
      await this.transport.request("owned_tree_exited", {
        owner: {
          role: owner.role,
          nonce: owner.nonce,
          identity: processIdentityToWire(owner.identity),
        },
      }),
    );
    if (typeof result.exited !== "boolean")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return result.exited;
  }
  async sameParentProcess(
    first: ConsumerProcessIdentity,
    second: ConsumerProcessIdentity,
  ): Promise<boolean> {
    const result = object(
      await this.transport.request("same_parent_process", {
        first: processIdentityToWire(first),
        second: processIdentityToWire(second),
      }),
    );
    if (typeof result.same !== "boolean")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return result.same;
  }
  async claimSessionTicket(nonce: string): Promise<boolean> {
    assertConsumerNonce(nonce);
    const result = object(
      await this.transport.request("claim_session_ticket", { nonce }),
    );
    if (typeof result.claimed !== "boolean")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return result.claimed;
  }
  async claimBrowserAccountTicket(nonce: string): Promise<boolean> {
    assertConsumerNonce(nonce);
    const result = object(
      await this.transport.request("claim_browser_account_ticket", { nonce }),
    );
    if (typeof result.claimed !== "boolean")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return result.claimed;
  }

  /** One connection, one sequence, one use of a random nonce; no replay window. */
  async inspectSingletonOwner(
    scope: ConsumerSingletonScope,
  ): Promise<ConsumerSingletonOwner> {
    if (scope !== "session" && scope !== "account")
      throw new ConsumerNativeError("BAD_REQUEST");
    const own = await this.identity(),
      row = object(
        await this.transport.request("singleton_inspect", { scope }),
      );
    if (Object.keys(row).sort().join() !== "owner,same_session,state")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    if (
      row.state === "absent" &&
      row.owner === null &&
      row.same_session === false
    )
      return { state: "absent", owner: null, sameSession: false };
    if (row.state !== "active" || typeof row.same_session !== "boolean")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    const owner = processIdentityFromWire(row.owner);
    if (
      owner.sid !== own.sid ||
      row.same_session !== (owner.sessionId === own.sessionId)
    )
      throw new ConsumerNativeError("PEER_DENIED");
    return { state: "active", owner, sameSession: row.same_session };
  }
  /** Ticket publication is permitted only for helpers of the exact gated parent authority. */
  async assertSingletonPublication(
    scope: ConsumerSingletonScope,
  ): Promise<void> {
    if (scope !== "session" && scope !== "account")
      throw new ConsumerNativeError("BAD_REQUEST");
    const row = object(
      await this.transport.request("singleton_assert_publication", { scope }),
    );
    if (Object.keys(row).join() !== "authorized" || row.authorized !== true)
      throw new ConsumerNativeError("PEER_DENIED");
  }
  async acquireMutex(
    scope: ConsumerMutexScope,
  ): Promise<ConsumerMutexLease | null> {
    if (
      ![
        "session",
        "account",
        "activation",
        "prepare",
        "acquisition",
        "cache",
        "metadata",
      ].includes(scope)
    )
      throw new ConsumerNativeError("BAD_REQUEST");
    const result = object(
      await this.transport.request("acquire_mutex", { scope }),
    );
    if (result.acquired === false) return null;
    if (
      result.acquired !== true ||
      result.scope !== scope ||
      typeof result.nonce !== "string" ||
      typeof result.abandoned !== "boolean"
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    assertConsumerNonce(result.nonce);
    const identity = processIdentityFromWire(result.identity);
    const current = await this.identity();
    if (
      identity.sid !== current.sid ||
      identity.sessionId !== current.sessionId ||
      identity.pid !== current.pid ||
      identity.creationTime !== current.creationTime
    )
      throw new ConsumerNativeError("PEER_DENIED");
    const lease = {
      scope,
      nonce: result.nonce,
      identity,
      abandoned: result.abandoned,
    };
    this.ownedMutexes.set(scope, lease);
    return structuredClone(lease);
  }
  async releaseMutex(lease: ConsumerMutexLease): Promise<void> {
    const owned = this.ownedMutexes.get(lease.scope);
    if (
      !owned ||
      owned.nonce !== lease.nonce ||
      JSON.stringify(processIdentityToWire(owned.identity)) !==
        JSON.stringify(processIdentityToWire(lease.identity))
    )
      throw new ConsumerNativeError("PEER_DENIED");
    const result = object(
      await this.transport.request("release_mutex", {
        scope: lease.scope,
        nonce: lease.nonce,
        identity: processIdentityToWire(lease.identity),
      }),
    );
    if (result.released !== true)
      throw new ConsumerNativeError("IDENTITY_UNAVAILABLE");
    this.ownedMutexes.delete(lease.scope);
  }
  async isOwnedProcess(
    owner: ConsumerOwnedProcess,
    identity: ConsumerProcessIdentity,
  ): Promise<boolean> {
    assertConsumerNonce(owner.nonce);
    const result = object(
      await this.transport.request("is_owned_process", {
        owner: {
          role: owner.role,
          nonce: owner.nonce,
          identity: processIdentityToWire(owner.identity),
        },
        identity: processIdentityToWire(identity),
      }),
    );
    if (typeof result.owned !== "boolean")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return result.owned;
  }
  async enumerateGpus(): Promise<ConsumerGpuIdentity[]> {
    const result = object(await this.transport.request("gpu_inventory", {}));
    if (!Array.isArray(result.gpus) || result.gpus.length > 16)
      throw new ConsumerNativeError("GPU_INVENTORY_UNAVAILABLE");
    const gpus = result.gpus.map(parseConsumerGpu);
    if (
      new Set(gpus.map((gpu) => gpu.luid)).size !== gpus.length ||
      new Set(gpus.map((gpu) => gpu.deviceIndex)).size !== gpus.length
    )
      throw new ConsumerNativeError("GPU_INVENTORY_UNAVAILABLE");
    return gpus;
  }
  async bindOwnedRole(owner: ConsumerOwnedProcess): Promise<void> {
    if (owner.role !== "personal" && owner.role !== "fleet")
      throw new ConsumerNativeError("JOB_NOT_OWNED");
    assertConsumerNonce(owner.nonce);
    const result = object(
      await this.transport.request("bind_role_job", {
        owner: {
          role: owner.role,
          nonce: owner.nonce,
          identity: processIdentityToWire(owner.identity),
        },
      }),
    );
    if (result.bound !== true) throw new ConsumerNativeError("JOB_NOT_OWNED");
  }
  /** Actual fixed role Job query. Guardian PID exit or an abandoned lease never
   * substitutes for this proof before consumer inference workspace cleanup. */
  async inferenceIdle(): Promise<boolean> {
    const row = object(await this.transport.request("inference_idle", {}));
    if (Object.keys(row).join() !== "idle" || typeof row.idle !== "boolean")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return row.idle;
  }
  /** An exact personal guardian/engine pair may stay loaded while the GPU
   * lease is retained. This capability never replaces inferenceIdle on release. */
  async registerRetainedEngine(
    guardian: ConsumerProcessIdentity,
    engine: ConsumerProcessIdentity,
  ): Promise<{ token: string }> {
    const own = await this.identity(),
      guardianWire = processIdentityToWire(guardian),
      engineWire = processIdentityToWire(engine);
    if (
      guardian.pid === engine.pid ||
      guardian.sid !== own.sid ||
      guardian.sessionId !== own.sessionId ||
      engine.sid !== own.sid ||
      engine.sessionId !== own.sessionId
    )
      throw new ConsumerNativeError("PEER_DENIED");
    const row = object(
      await this.transport.request("retained_engine_register", {
        guardian: guardianWire,
        engine: engineWire,
      }),
    );
    if (
      Object.keys(row).join() !== "token" ||
      typeof row.token !== "string" ||
      !/^[a-f0-9]{64}$/u.test(row.token)
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return { token: row.token };
  }
  async beginRetainedEngine(token: string, jobId: string): Promise<void> {
    assertConsumerNonce(token);
    assertExportDiscardRequestId(jobId);
    const row = object(
      await this.transport.request("retained_engine_begin", {
        token,
        job_id: jobId,
      }),
    );
    if (Object.keys(row).join() !== "busy" || row.busy !== true)
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  }
  /** Issue only after the trusted engine response proves attempt detachment. */
  async completeRetainedEngine(token: string, jobId: string): Promise<void> {
    assertConsumerNonce(token);
    assertExportDiscardRequestId(jobId);
    const row = object(
      await this.transport.request("retained_engine_complete", {
        token,
        job_id: jobId,
      }),
    );
    if (Object.keys(row).join() !== "idle" || row.idle !== true)
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  }
  async retainedEngineIdle(token: string): Promise<boolean> {
    assertConsumerNonce(token);
    const row = object(
      await this.transport.request("retained_engine_idle", { token }),
    );
    if (Object.keys(row).join() !== "idle" || typeof row.idle !== "boolean")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return row.idle;
  }
  async forgetRetainedEngine(token: string): Promise<void> {
    assertConsumerNonce(token);
    const row = object(
      await this.transport.request("retained_engine_forget", { token }),
    );
    if (Object.keys(row).join() !== "forgotten" || row.forgotten !== true)
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  }
  async acquireGpuGuard(
    selected: ConsumerGpuIdentity | string,
  ): Promise<ConsumerGpuLease | null> {
    const luid =
      typeof selected === "string" ? selected : parseConsumerGpu(selected).luid;
    if (!/^[a-f0-9]{16}$/u.test(luid))
      throw new ConsumerNativeError("BAD_REQUEST");
    const lease = parseConsumerGpuLease(
      await this.transport.request("acquire_gpu_guard", { luid }, 15_000),
    );
    if (!lease) return null;
    // Track the returned capability before checking its metadata, so rejection
    // cannot leak an acknowledged native guard in this helper.
    this.ownedGpuGuards.set(lease.luid, lease);
    try {
      if (
        lease.luid !== luid ||
        (typeof selected !== "string" &&
          JSON.stringify(lease.gpu) !==
            JSON.stringify(parseConsumerGpu(selected)))
      )
        throw new ConsumerNativeError("GPU_GUARD_UNSAFE");
      const own = await this.identity();
      if (
        JSON.stringify(processIdentityToWire(lease.identity)) !==
        JSON.stringify(processIdentityToWire(own))
      )
        throw new ConsumerNativeError("PEER_DENIED");
      return structuredClone(lease);
    } catch (error) {
      try {
        await this.releaseGpuGuard(lease);
      } catch {
        await this.close();
      }
      throw error;
    }
  }
  async releaseGpuGuard(lease: ConsumerGpuLease): Promise<void> {
    const owned = this.ownedGpuGuards.get(lease.luid);
    if (
      !owned ||
      owned.nonce !== lease.nonce ||
      JSON.stringify(processIdentityToWire(owned.identity)) !==
        JSON.stringify(processIdentityToWire(lease.identity))
    )
      throw new ConsumerNativeError("PEER_DENIED");
    const result = object(
      await this.transport.request(
        "release_gpu_guard",
        {
          luid: lease.luid,
          nonce: lease.nonce,
          identity: processIdentityToWire(lease.identity),
        },
        15_000,
      ),
    );
    if (result.released !== true)
      throw new ConsumerNativeError("GPU_GUARD_UNSAFE");
    this.ownedGpuGuards.delete(lease.luid);
  }
  async inspectStartup(): Promise<
    "absent" | "registered" | "disabled" | "conflict" | "unknown"
  > {
    return this.startupResult(
      await this.transport.request("startup_inspect", {}),
    );
  }
  async registerStartup(
    launcherSha256: string,
  ): Promise<"absent" | "registered" | "disabled" | "conflict" | "unknown"> {
    this.assertDigest(launcherSha256);
    return this.startupResult(
      await this.transport.request("startup_register", {
        launcher_sha256: launcherSha256,
      }),
    );
  }
  async removeStartup(): Promise<void> {
    if (
      this.startupResult(await this.transport.request("startup_remove", {})) !==
      "absent"
    )
      throw new ConsumerNativeError("STARTUP_CONFLICT");
  }
  async legacyWorkerConflict(): Promise<boolean> {
    const result = object(
      await this.transport.request("legacy_worker_conflict", {}),
    );
    if (typeof result.conflict !== "boolean")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return result.conflict;
  }
  async launchSessionAgent(
    launcherSha256: string,
  ): Promise<ConsumerProcessIdentity> {
    this.assertDigest(launcherSha256);
    const result = object(
      await this.transport.request("launch_session_agent", {
        launcher_sha256: launcherSha256,
      }),
    );
    return processIdentityFromWire(result.identity);
  }
  async verifySessionLauncher(
    launcherSha256: string,
    expectedBytes?: number,
  ): Promise<void> {
    this.assertDigest(launcherSha256);
    const result = object(
      await this.transport.request("launcher_verify", {
        launcher_sha256: launcherSha256,
      }),
    );
    if (
      result.verified !== true ||
      !Number.isSafeInteger(result.bytes) ||
      (result.bytes as number) < 1 ||
      (result.bytes as number) > 16 * 1024 * 1024 ||
      (expectedBytes !== undefined && expectedBytes !== result.bytes)
    )
      throw new ConsumerNativeError("HELPER_INTEGRITY_INVALID");
  }
  async registerBrowser(options: {
    extensionId: string;
    hostSha256: string;
    hostBytes: number;
    entrySha256: string;
    entryBytes: number;
  }): Promise<void> {
    if (
      !/^[a-p]{32}$/u.test(options.extensionId) ||
      !Number.isSafeInteger(options.hostBytes) ||
      options.hostBytes < 1 ||
      options.hostBytes > 16 * 1024 * 1024 ||
      !Number.isSafeInteger(options.entryBytes) ||
      options.entryBytes < 1 ||
      options.entryBytes > 32 * 1024 * 1024
    )
      throw new ConsumerNativeError("BAD_REQUEST");
    this.assertDigest(options.hostSha256);
    this.assertDigest(options.entrySha256);
    const result = object(
      await this.transport.request(
        "browser_register",
        {
          extension_id: options.extensionId,
          host_sha256: options.hostSha256,
          host_bytes: options.hostBytes,
          entry_sha256: options.entrySha256,
          entry_bytes: options.entryBytes,
        },
        35_000,
      ),
    );
    if (
      Object.keys(result).sort().join() !== "registered,views" ||
      result.registered !== true ||
      JSON.stringify(result.views) !== "[32,64]"
    )
      throw new ConsumerNativeError("BROWSER_REGISTRATION_CONFLICT");
  }
  async unregisterBrowser(): Promise<void> {
    const result = object(
      await this.transport.request("browser_unregister", {}, 35_000),
    );
    if (Object.keys(result).join() !== "removed" || result.removed !== true)
      throw new ConsumerNativeError("BROWSER_REGISTRATION_CONFLICT");
  }
  async verifyBrowser(options: {
    extensionId: string;
    hostSha256: string;
    hostBytes: number;
    entrySha256: string;
    entryBytes: number;
  }): Promise<boolean> {
    this.assertDigest(options.hostSha256);
    this.assertDigest(options.entrySha256);
    if (
      !/^[a-p]{32}$/u.test(options.extensionId) ||
      !Number.isSafeInteger(options.hostBytes) ||
      options.hostBytes < 1 ||
      options.hostBytes > 16 * 1024 * 1024 ||
      !Number.isSafeInteger(options.entryBytes) ||
      options.entryBytes < 1 ||
      options.entryBytes > 32 * 1024 * 1024
    )
      throw new ConsumerNativeError("BAD_REQUEST");
    const result = object(
      await this.transport.request("browser_inspect", {
        extension_id: options.extensionId,
        host_sha256: options.hostSha256,
        host_bytes: options.hostBytes,
        entry_sha256: options.entrySha256,
        entry_bytes: options.entryBytes,
      }),
    );
    if (
      Object.keys(result).join() !== "registered" ||
      typeof result.registered !== "boolean"
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return result.registered;
  }
  private assertDigest(value: string): void {
    if (!/^[a-f0-9]{64}$/u.test(value))
      throw new ConsumerNativeError("HELPER_INTEGRITY_INVALID");
  }
  private startupResult(
    value: unknown,
  ): "absent" | "registered" | "disabled" | "conflict" | "unknown" {
    const result = object(value);
    if (
      !["absent", "registered", "disabled", "conflict", "unknown"].includes(
        result.state as string,
      ) ||
      result.scope !== "HKCU" ||
      result.value_name !== "MusicMuteSession"
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return result.state as
      "absent" | "registered" | "disabled" | "conflict" | "unknown";
  }

  async pipeExchange(options: {
    channel: string;
    nonce: string;
    peer: ConsumerProcessIdentity;
    response: Uint8Array;
    timeoutMs?: number;
  }): Promise<Buffer> {
    assertConsumerNonce(options.channel);
    assertConsumerNonce(options.nonce);
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 30_000 ||
      options.response.byteLength > CONSUMER_NATIVE_MAX_PIPE_RESPONSE
    )
      throw new ConsumerNativeError("BAD_REQUEST");
    const owner = await this.identity();
    if (
      options.peer.sid !== owner.sid ||
      options.peer.sessionId !== owner.sessionId
    )
      throw new ConsumerNativeError("PEER_DENIED");
    this.consumePipeCapability(options.channel, options.nonce);
    const result = object(
      await this.transport.request(
        "pipe_exchange",
        {
          channel: options.channel,
          nonce: options.nonce,
          peer: processIdentityToWire(options.peer),
          timeout_ms: timeoutMs,
          response_base64: Buffer.from(options.response).toString("base64"),
        },
        timeoutMs + 2_000,
      ),
    );
    assertConsumerPipePeer(
      owner,
      options.peer,
      processIdentityFromWire(result.peer),
      options.nonce,
      options.nonce,
    );
    return decodeConsumerBase64(
      result.payload_base64,
      CONSUMER_NATIVE_MAX_PIPE_PAYLOAD,
    );
  }

  /** Client counterpart uses specific pipe rights and authenticates the server. */
  async pipeConnect(options: {
    channel: string;
    nonce: string;
    peer: ConsumerProcessIdentity;
    payload: Uint8Array;
    timeoutMs?: number;
  }): Promise<Buffer> {
    assertConsumerNonce(options.channel);
    assertConsumerNonce(options.nonce);
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 30_000 ||
      options.payload.byteLength > CONSUMER_NATIVE_MAX_PIPE_PAYLOAD
    )
      throw new ConsumerNativeError("BAD_REQUEST");
    const owner = await this.identity();
    if (
      options.peer.sid !== owner.sid ||
      options.peer.sessionId !== owner.sessionId
    )
      throw new ConsumerNativeError("PEER_DENIED");
    const capability = options.channel + ":" + options.nonce;
    if (this.usedClientCapabilities.has(capability))
      throw new ConsumerNativeError("PEER_DENIED");
    this.usedClientCapabilities.add(capability);
    if (this.usedClientCapabilities.size > 64)
      this.usedClientCapabilities.delete(
        this.usedClientCapabilities.keys().next().value!,
      );
    const result = object(
      await this.transport.request(
        "pipe_connect",
        {
          channel: options.channel,
          nonce: options.nonce,
          peer: processIdentityToWire(options.peer),
          timeout_ms: timeoutMs,
          payload_base64: Buffer.from(options.payload).toString("base64"),
        },
        timeoutMs + 2_000,
      ),
    );
    assertConsumerPipePeer(
      owner,
      options.peer,
      processIdentityFromWire(result.peer),
      options.nonce,
      options.nonce,
    );
    return decodeConsumerBase64(
      result.payload_base64,
      CONSUMER_NATIVE_MAX_PIPE_RESPONSE,
    );
  }

  close(): Promise<void> {
    return this.transport.close();
  }
  onEvent(listener: (event: ConsumerNativeEvent) => void): () => void {
    if (!this.transport.onEvent)
      throw new ConsumerNativeError("HELPER_UNAVAILABLE");
    return this.transport.onEvent(listener);
  }
  onClosed(listener: () => void): () => void {
    if (!this.transport.onClosed)
      throw new ConsumerNativeError("HELPER_UNAVAILABLE");
    return this.transport.onClosed(listener);
  }
  async pipeAccept(options: {
    channel: string;
    nonce: string;
    peer: ConsumerProcessIdentity | null;
    timeoutMs?: number;
  }): Promise<{ connection: ConsumerPipeConnection; payload: Buffer }> {
    assertConsumerNonce(options.channel);
    assertConsumerNonce(options.nonce);
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)
      throw new ConsumerNativeError("BAD_REQUEST");
    const owner = await this.identity();
    if (
      options.peer &&
      (options.peer.sid !== owner.sid ||
        options.peer.sessionId !== owner.sessionId)
    )
      throw new ConsumerNativeError("PEER_DENIED");
    this.consumePipeCapability(options.channel, options.nonce);
    const result = object(
      await this.transport.request(
        "pipe_accept",
        {
          channel: options.channel,
          nonce: options.nonce,
          peer: options.peer ? processIdentityToWire(options.peer) : null,
          timeout_ms: timeoutMs,
        },
        timeoutMs + 2_000,
      ),
    );
    const wire = object(result.connection);
    if (typeof wire.token !== "string" || typeof wire.nonce !== "string")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    assertConsumerNonce(wire.token);
    assertConsumerNonce(wire.nonce);
    const peer = processIdentityFromWire(wire.peer);
    assertConsumerPipePeer(
      owner,
      options.peer ?? peer,
      peer,
      options.nonce,
      wire.nonce,
    );
    const payload = decodeConsumerBase64(
      result.payload_base64,
      CONSUMER_NATIVE_MAX_PIPE_PAYLOAD,
    );
    const connection = { token: wire.token, nonce: wire.nonce, peer };
    if (
      this.ownedConnections.size >= 16 ||
      this.ownedConnections.has(connection.token)
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    this.ownedConnections.set(connection.token, connection);
    return { connection: structuredClone(connection), payload };
  }
  async pipeReply(
    connection: ConsumerPipeConnection,
    payload: Uint8Array,
  ): Promise<void> {
    assertConsumerNonce(connection.token);
    assertConsumerNonce(connection.nonce);
    if (payload.byteLength > CONSUMER_NATIVE_MAX_PIPE_RESPONSE)
      throw new ConsumerNativeError("BAD_REQUEST");
    this.consumeOwnedConnection(connection);
    const result = object(
      await this.transport.request("pipe_reply", {
        token: connection.token,
        nonce: connection.nonce,
        peer: processIdentityToWire(connection.peer),
        payload_base64: Buffer.from(payload).toString("base64"),
      }),
    );
    if (result.replied !== true)
      throw new ConsumerNativeError("PIPE_UNAVAILABLE");
  }
  async pipeClose(connection: ConsumerPipeConnection): Promise<void> {
    assertConsumerNonce(connection.token);
    assertConsumerNonce(connection.nonce);
    this.consumeOwnedConnection(connection);
    const result = object(
      await this.transport.request("pipe_close", {
        token: connection.token,
        nonce: connection.nonce,
        peer: processIdentityToWire(connection.peer),
      }),
    );
    if (result.closed !== true)
      throw new ConsumerNativeError("PIPE_UNAVAILABLE");
  }
  private consumeOwnedConnection(connection: ConsumerPipeConnection): void {
    const known = this.ownedConnections.get(connection.token);
    if (!known) throw new ConsumerNativeError("PIPE_UNAVAILABLE");
    if (
      known.nonce !== connection.nonce ||
      JSON.stringify(processIdentityToWire(known.peer)) !==
        JSON.stringify(processIdentityToWire(connection.peer))
    )
      throw new ConsumerNativeError("PEER_DENIED");
    this.ownedConnections.delete(connection.token);
  }
  private consumePipeCapability(channel: string, nonce: string): void {
    const capability = `${channel}:${nonce}`;
    if (
      this.usedPipeCapabilities.has(capability) ||
      this.usedPipeCapabilities.size >= 4096
    )
      throw new ConsumerNativeError("PEER_DENIED");
    this.usedPipeCapabilities.add(capability);
  }
  private assertVaultKey(key: string): void {
    if (!/^[a-z0-9_-]{1,64}$/u.test(key))
      throw new ConsumerNativeError("BAD_REQUEST");
  }
}
