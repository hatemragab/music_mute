/** Replaced with a string literal by the desktop/agent compiler. Packaged code
 * never reads an environment variable, configuration file or command-line flag
 * to choose its package authority. Undefined is the strict source-test default. */
declare const __MUSICMUTE_PACKAGE_AUTHORITY_PROFILE__: string;

type PackageAuthorityProfile = "store-v1" | "local-test-v1";
function compiledProfile(): PackageAuthorityProfile {
  if (typeof __MUSICMUTE_PACKAGE_AUTHORITY_PROFILE__ === "undefined")
    return "store-v1";
  if (
    __MUSICMUTE_PACKAGE_AUTHORITY_PROFILE__ === "store-v1" ||
    __MUSICMUTE_PACKAGE_AUTHORITY_PROFILE__ === "local-test-v1"
  )
    return __MUSICMUTE_PACKAGE_AUTHORITY_PROFILE__;
  throw new Error("PACKAGE_BUILD_PROFILE_INVALID");
}

export const PACKAGE_AUTHORITY_PROFILE = compiledProfile();
export const PACKAGE_AUTHORITY_KIND =
  PACKAGE_AUTHORITY_PROFILE === "local-test-v1"
    ? ("local-developer-test" as const)
    : ("microsoft-store" as const);
export const PACKAGE_REQUIRED_SIGNATURE_KIND =
  PACKAGE_AUTHORITY_PROFILE === "local-test-v1" ? (1 as const) : (3 as const);
export const PACKAGE_DATA_ROOT_NAMES = Object.freeze({
  personal:
    PACKAGE_AUTHORITY_PROFILE === "local-test-v1"
      ? "MusicMuteLocalDevelopment"
      : "MusicMuteLocal",
  fleet:
    PACKAGE_AUTHORITY_PROFILE === "local-test-v1"
      ? "MusicMuteWorkerDevelopment"
      : "MusicMuteWorker",
});
