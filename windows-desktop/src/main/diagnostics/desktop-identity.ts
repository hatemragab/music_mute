import type { WindowsDiagnosticIdentity } from "../../shared/diagnostics-contracts.js";
import { packagedResourceInventorySha256 } from "../browser/package-trust.js";
import { parseDiagnosticIdentity } from "./projection.js";

export function desktopDiagnosticIdentity(
  identity: Omit<WindowsDiagnosticIdentity, "packageInventorySha256">,
): WindowsDiagnosticIdentity {
  const digest = packagedResourceInventorySha256();
  if (identity.runtimeScope === "packaged-app" && !digest)
    throw new Error("DIAGNOSTICS_CONTEXT_INVALID");
  return parseDiagnosticIdentity({
    softwareVersion: identity.softwareVersion,
    runtimeScope: identity.runtimeScope,
    expectedModelSha256: identity.expectedModelSha256,
    ...(digest ? { packageInventorySha256: digest } : {}),
  });
}
