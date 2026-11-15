import {
  QA_CHROME_PUBLIC_KEY,
  QA_EXTENSION_ID,
  parsePrototypeIdentity,
} from "./contract.ts";

/** Fixed local fixture files only. No generated user input, profile edits,
 * content scripts, URLs, account/media access, processing or network code. */
export function chromeFixtureFiles(identity) {
  const plan = parsePrototypeIdentity(identity);
  const hosts = ["direct", "system", "breakaway"].flatMap((mode) =>
    ["fixed", "alias"].map((kind) => ({
      label: `${mode} / ${kind}`,
      name: `${plan.hostNames[kind]}.${mode}`,
    })),
  );
  hosts.push({
    label: "immutable package / fixed",
    name: `${plan.hostNames.fixed}.immutable`,
  });
  return {
    "manifest.json":
      JSON.stringify(
        {
          manifest_version: 3,
          name: "MusicMute S03 isolated QA",
          description: "Disposable HELLO/ECHO fixture; no accounts or media",
          version: "1.0.0",
          key: QA_CHROME_PUBLIC_KEY,
          permissions: ["nativeMessaging"],
          action: {
            default_title: "MusicMute S03 isolated QA",
            default_popup: "popup.html",
          },
          content_security_policy: {
            extension_pages:
              "script-src 'self'; object-src 'none'; base-uri 'none';",
          },
        },
        null,
        2,
      ) + "\n",
    "popup.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>MusicMute S03 isolated QA</title><link rel="stylesheet" href="popup.css"><script src="popup.js" defer></script></head>
<body><h1>MusicMute S03 isolated QA</h1><p>This fixture sends two local messages. It has no account, song, worker or backend access.</p><p id="identity"></p><label for="host">Registered QA host</label><select id="host"></select><button id="run" type="button">Test HELLO and Unicode ECHO</button><pre id="result" role="status" aria-live="polite" tabindex="0">Choose a host registered by this QA package.</pre></body></html>
`,
    "popup.css": `body{font:14px system-ui,sans-serif;margin:16px;width:580px;color:#172b2c;background:#fafdfd}h1{font-size:20px}label,select,button{display:block;margin-top:12px}select,button{font:inherit;padding:8px;max-width:100%}button{background:#1a7075;color:white;border:0;border-radius:4px}button:disabled{opacity:.6}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf5f5;padding:12px;max-height:480px;overflow:auto}
`,
    "popup.js": `"use strict";
(() => {
  const extensionId = ${JSON.stringify(QA_EXTENSION_ID)};
  const packageName = ${JSON.stringify(plan.packageName)};
  const hosts = Object.freeze(${JSON.stringify(hosts)});
  const echoText = "مرحبا 🎵";
  const select = document.getElementById("host"), button = document.getElementById("run"), result = document.getElementById("result");
  document.getElementById("identity").textContent = packageName + " / " + extensionId;
  for (const [index, host] of hosts.entries()) { const option = document.createElement("option"); option.value = String(index); option.textContent = host.label; select.append(option); }
  const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
  const test = (hostName) => new Promise((resolve, reject) => {
    if (chrome.runtime.id !== extensionId || !hosts.some(host => host.name === hostName)) return reject(new Error("MSIX_QA_CHROME_IDENTITY_INVALID"));
    let port, pending, hello, echo, settled = false;
    const finish = (error) => { if (settled) return; settled = true; clearTimeout(deadline); if (port) port.disconnect(); if (error) reject(error); else resolve({hello, echo}); };
    const deadline = setTimeout(() => finish(new Error("MSIX_QA_CHROME_TIMEOUT")), 10000);
    const send = (type) => { pending = {protocol_version:1, request_id:crypto.randomUUID(), type, payload:type === "HELLO" ? {} : {text:echoText}}; port.postMessage(pending); };
    try {
      port = chrome.runtime.connectNative(hostName);
      port.onDisconnect.addListener(() => { const nativeError = chrome.runtime.lastError; if (!settled) finish(new Error(nativeError ? String(nativeError.message).slice(0,200) : "MSIX_QA_CHROME_DISCONNECTED")); });
      port.onMessage.addListener((message) => {
        try {
          if (!exact(message, ["protocol_version","request_id","type","payload"]) || JSON.stringify(message).length > 65536 || message.protocol_version !== 1 || message.request_id !== pending.request_id || message.type !== pending.type || !message.payload || typeof message.payload !== "object" || Array.isArray(message.payload) || message.payload.qa_only !== true) throw new Error("MSIX_QA_CHROME_RESPONSE_INVALID");
          if (pending.type === "HELLO") {
            const value = message.payload.observation;
            if (!exact(message.payload,["ready","qa_only","observation"]) || message.payload.ready !== false || !value || value.package_name !== packageName || value.signature_kind !== 0 || value.production_store_origin_allowed !== false || value.qa_only !== true || value.elevated !== false || !Number.isInteger(value.session_id) || value.session_id <= 0 || !value.process_package || value.process_package.has_identity !== true || value.process_package.full_name !== value.package_full_name) throw new Error("MSIX_QA_CHROME_PACKAGE_INVALID");
            hello = message; send("ECHO");
          } else { if (!exact(message.payload,["text","qa_only"]) || message.payload.text !== echoText) throw new Error("MSIX_QA_CHROME_ECHO_INVALID"); echo = message; finish(); }
        } catch (error) { finish(error); }
      });
      send("HELLO");
    } catch (error) { finish(error); }
  });
  button.addEventListener("click", async () => {
    const index = Number(select.value); if (!Number.isInteger(index) || index < 0 || index >= hosts.length) { result.textContent = "MSIX_QA_CHROME_HOST_INVALID"; return; }
    const hostName = hosts[index].name, started = performance.now(); button.disabled = true; result.textContent = "Testing " + hostName;
    try { const messages = await test(hostName); result.textContent = JSON.stringify({qa_only:true, success:true, extension_id:chrome.runtime.id, host_name:hostName, elapsed_ms:Math.round(performance.now()-started), ...messages},null,2); }
    catch (error) { result.textContent = JSON.stringify({qa_only:true, success:false, extension_id:chrome.runtime.id, host_name:hostName, error:error instanceof Error ? error.message.slice(0,200) : "MSIX_QA_CHROME_FAILED"},null,2); }
    finally { button.disabled = false; }
  });
})();
`,
  };
}
