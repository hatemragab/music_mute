import { once } from "node:events";
import { openWindowsHost } from "../main/host-context.js";
import { openDesktopSessionClient } from "../main/session/desktop-client.js";
import { loadBrowserIntegrationManifest } from "../main/browser/registration.js";
import {
  BrowserFrameDecoder,
  encodeBrowserFrame,
} from "../main/browser/framing.js";
import { createBrowserMedia } from "../main/browser/media.js";
import { WindowsBrowserService } from "../main/browser/service.js";
import { unavailableBrowserReply } from "../main/browser/unavailable.js";
import { BrowserAccountClient } from "../main/browser/account-bridge.js";
import {
  loadBrowserAccountAppPin,
  openBrowserNative,
} from "../main/browser/native.js";
import { loadPackagedDesktopBuild } from "../main/browser/package-trust.js";
import {
  StoreNativeAuthority,
  storeAuthorityForDataNative,
} from "../main/browser/store-native.js";
import { openStoreAccountNative } from "../main/browser/store-account-native.js";
import { parseStoreBrowserAttachInput } from "../main/browser/store-registration.js";
import { StoreSessionClient } from "../main/session/store-session-client.js";
export async function runBrowserHost(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  delete process.env.MUSICMUTE_OWNERSHIP_NONCE;
  delete process.env.MUSICMUTE_OWNERSHIP_ROLE;
  const store = process.windowsStore === true;
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    argv.length !== (store ? 8 : 4) ||
    argv[0] !== "--origin" ||
    argv[2] !== "--resources" ||
    !argv[1] ||
    !argv[3]
  )
    throw new Error("BROWSER_HOST_UNAVAILABLE");
  const resources = argv[3],
    manifest = await loadBrowserIntegrationManifest(resources),
    origin = argv[1].replace(/\/$/u, "");
  if (origin !== `chrome-extension://${manifest.extensionId}`)
    throw new Error("EXTENSION_ORIGIN_REQUIRED");
  const build = await loadPackagedDesktopBuild(resources);
  const host = await openWindowsHost(
    resources,
    build.appVersion,
    build.buildNumber,
  );
  let accountNative: Awaited<ReturnType<typeof openBrowserNative>> | undefined;
  let account: BrowserAccountClient | undefined;
  let connected:
      Awaited<ReturnType<typeof openDesktopSessionClient>> | undefined,
    service: WindowsBrowserService | undefined;
  let storeConnected: StoreSessionClient | undefined;
  let bodyFailure: unknown;
  let bodyFailed = false;
  const run = async (): Promise<void> => {
    if (store) {
      if (
        !host.storeAuthority ||
        argv[4] !== "--store-browser-host" ||
        argv[6] !== "--store-browser-nonce" ||
        !/^[1-9][0-9]{0,9}$/u.test(argv[5] ?? "")
      )
        throw new Error("STORE_BROWSER_DENIED");
      await host.storeAuthority.browserAttach(
        parseStoreBrowserAttachInput({
          hostPid: Number(argv[5]),
          nonce: argv[7],
          origin: argv[1],
        }),
      );
    } else if (host.storeAuthority) throw new Error("STORE_BROWSER_DENIED");
    const openAccountNative = async () => {
      if (!store) return openBrowserNative(host, resources);
      if (!host.storeAuthority) throw new Error("STORE_BROWSER_DENIED");
      const peer = await StoreNativeAuthority.openBrowserWaitingPeer(
        host.storeAuthority,
      );
      try {
        return StoreNativeAuthority.prototype.borrowDataNative.call(peer);
      } catch (error) {
        await StoreNativeAuthority.prototype.close.call(peer);
        throw error;
      }
    };
    try {
      accountNative = await openAccountNative();
      if (store) {
        const accountPort = async (native: typeof accountNative) => {
          if (!native) throw new Error("STORE_ACCOUNT_DENIED");
          const authority = storeAuthorityForDataNative(native);
          if (!authority) throw new Error("STORE_ACCOUNT_DENIED");
          return openStoreAccountNative(authority);
        };
        account = new BrowserAccountClient(
          await accountPort(accountNative),
          undefined,
          async () => {
            const native = await openAccountNative();
            try {
              return await accountPort(native);
            } catch (error) {
              await native.close();
              throw error;
            }
          },
        );
      } else {
        account = new BrowserAccountClient(
          accountNative,
          await loadBrowserAccountAppPin(resources),
          () => openBrowserNative(host, resources),
        );
      }
      await account.connect();
    } catch (failure) {
      const code =
        failure instanceof Error &&
        failure.message === "WINDOWS_SESSION_ALREADY_ACTIVE"
          ? "WINDOWS_SESSION_ALREADY_ACTIVE"
          : "LOCAL_INSTALL_REQUIRED";
      const decoder = new BrowserFrameDecoder();
      for await (const chunk of process.stdin)
        for (const command of decoder.push(chunk as Buffer)) {
          if (
            !process.stdout.write(
              encodeBrowserFrame(unavailableBrowserReply(command, code)),
            )
          )
            await once(process.stdout, "drain");
        }
      decoder.finish();
      return;
    }
    const processIdentity = (pid: number) =>
      accountNative!.processIdentity(pid);
    const media = await createBrowserMedia(
      host,
      origin,
      async (id, sha) => (service ? service.authorizeMedia(id, sha) : false),
      processIdentity,
    );
    service = new WindowsBrowserService({
      ...(store ? { distribution: "microsoft-store" as const } : {}),
      account,
      getSession: async () => {
        if (store) {
          const source = host.storeAuthority;
          if (!source) throw new Error("BROWSER_HOST_UNAVAILABLE");
          storeConnected ??= await StoreSessionClient.openBrowser(source);
          return storeConnected;
        }
        connected ??= await openDesktopSessionClient(host, resources);
        return connected.client;
      },
      personalPeer: async () =>
        store
          ? storeConnected
            ? StoreSessionClient.prototype.personalPeer.call(storeConnected)
            : undefined
          : connected?.native.identity(),
      media,
      write: async (reply) => {
        if (!process.stdout.write(encodeBrowserFrame(reply)))
          await once(process.stdout, "drain");
      },
      onDisconnected: () => {
        process.stdin.destroy();
      },
    });
    const decoder = new BrowserFrameDecoder();
    for await (const chunk of process.stdin) {
      for (const command of decoder.push(chunk as Buffer))
        await service.command(command);
    }
    decoder.finish();
  };
  try {
    await run();
  } catch (error) {
    bodyFailed = true;
    bodyFailure = error;
  }
  if (store) {
    const failures: unknown[] = [];
    try {
      if (service) await service.close();
      else await account?.close();
    } catch (error) {
      failures.push(error);
    }
    // Retire the original derived control resources while their attached
    // source is still live. Closing the source first would revoke this exact
    // client while it joins its own pending replies and helper closures.
    try {
      if (storeConnected)
        await StoreSessionClient.prototype.close.call(storeConnected);
    } catch (error) {
      failures.push(error);
    }
    const retired = await Promise.allSettled([
      Promise.resolve().then(() => connected?.close()),
      Promise.resolve().then(() => accountNative?.close()),
      Promise.resolve().then(() => host.close()),
    ]);
    for (const result of retired)
      if (result.status === "rejected") failures.push(result.reason);
    if (failures.length)
      throw new AggregateError(
        bodyFailed ? [bodyFailure, ...failures] : failures,
        "BROWSER_CLEANUP_UNCONFIRMED",
      );
  } else {
    try {
      await service?.close();
    } finally {
      if (!service) await account?.close().catch(() => {});
      await Promise.allSettled([
        connected?.close(),
        accountNative?.close(),
        host.close(),
      ]);
    }
  }
  if (bodyFailed) throw bodyFailure;
}
