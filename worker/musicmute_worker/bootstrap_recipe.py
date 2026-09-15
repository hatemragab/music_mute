"""Offline native entrypoint rendering from operator-verified release inputs.

This validates configuration, not release provenance. H01 must authenticate the
bundle and initial root before supplying this recipe. No remote recipe is read.
"""

import argparse
import json
import re
import shlex
from pathlib import Path
from urllib.parse import urlsplit


def _https(value, *, origin=False):
    if not isinstance(value, str) or not re.fullmatch(
        r"https://[A-Za-z0-9./:_-]+", value
    ):
        raise ValueError("Invalid bootstrap HTTPS URL")
    parsed = urlsplit(value)
    if parsed.port is not None and not 1 <= parsed.port <= 65535:
        raise ValueError("Invalid bootstrap HTTPS port")
    if (
        not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or (origin and parsed.path)
        or any(part in (".", "..") for part in parsed.path.split("/"))
        or value.endswith("/")
    ):
        raise ValueError("Invalid bootstrap HTTPS origin/path")
    return value


def _integer(value, maximum):
    if type(value) is not int or not 1 <= value <= maximum:
        raise ValueError("Invalid bootstrap bound")
    return value


def _path(value):
    if (
        not isinstance(value, str)
        or not re.fullmatch(r"[A-Za-z0-9_-]+(?:/[A-Za-z0-9_.-]+)+", value)
        or any(part in (".", "..") for part in value.split("/"))
    ):
        raise ValueError("Invalid bootstrap relative path")
    return value


def validate_recipe(value):
    if (
        not isinstance(value, dict)
        or set(value)
        != {
            "schemaVersion",
            "installerBuild",
            "launcherBuild",
            "apiBaseUrl",
            "distributionOrigin",
            "bundles",
        }
        or type(value["schemaVersion"]) is not int
        or value["schemaVersion"] != 3
    ):
        raise ValueError("Invalid bootstrap recipe")
    _integer(value["installerBuild"], 2**31 - 1)
    _integer(value["launcherBuild"], 2**31 - 1)
    _https(value["apiBaseUrl"])
    if not value["apiBaseUrl"].endswith("/api/v1"):
        raise ValueError("Invalid setup API base")
    origin = _https(value["distributionOrigin"], origin=True)
    bundles = value["bundles"]
    if not isinstance(bundles, list) or not 1 <= len(bundles) <= 6:
        raise ValueError("Invalid bootstrap bundle set")
    seen = set()
    for bundle in bundles:
        if not isinstance(bundle, dict) or set(bundle) != {
            "os",
            "arch",
            "url",
            "sha256",
            "bytes",
            "expandedBytes",
            "pythonPath",
            "rootPath",
            "rootSha256",
        }:
            raise ValueError("Invalid bootstrap bundle")
        os_name, arch = bundle["os"], bundle["arch"]
        if os_name not in ("windows", "macos", "linux") or arch not in ("x64", "arm64"):
            raise ValueError("Invalid bootstrap platform")
        if (os_name, arch) in seen:
            raise ValueError("Duplicate bootstrap platform")
        seen.add((os_name, arch))
        for field in ("sha256", "rootSha256"):
            if not isinstance(bundle[field], str) or not re.fullmatch(
                r"[a-f0-9]{64}", bundle[field]
            ):
                raise ValueError("Invalid bootstrap digest")
        _integer(bundle["bytes"], 1024**3)
        _integer(bundle["expandedBytes"], 4 * 1024**3)
        if bundle["expandedBytes"] < bundle["bytes"]:
            raise ValueError("Invalid bootstrap expanded bound")
        _path(bundle["pythonPath"])
        if bundle["pythonPath"] != (
            "python/python.exe" if os_name == "windows" else "python/bin/python3"
        ):
            raise ValueError("Invalid native bootstrap interpreter layout")
        _path(bundle["rootPath"])
        url = _https(bundle["url"])
        suffix = ".zip" if os_name == "windows" else ".tar.gz"
        if not url.startswith(origin + "/releases/") or not url.endswith(suffix):
            raise ValueError("Bootstrap URL is outside immutable releases")
        if "/" + bundle["sha256"] + "/" not in url:
            raise ValueError("Bootstrap URL must bind its digest")
    return value


def render_entrypoint(recipe, platform, *, templates=None):
    recipe = validate_recipe(recipe)
    if platform not in ("posix", "windows"):
        raise ValueError("Unknown bootstrap entrypoint platform")
    bundles = [
        b
        for b in recipe["bundles"]
        if (b["os"] == "windows") == (platform == "windows")
    ]
    if not bundles:
        raise ValueError("No bundles for requested entrypoint")
    templates = templates or Path(__file__).resolve().parents[1] / "install"
    if platform == "posix":
        lines = ["BOOTSTRAP_CONFIGURED=1"]
        for key, field in (
            ("API", "apiBaseUrl"),
            ("ORIGIN", "distributionOrigin"),
            ("INSTALLER_BUILD", "installerBuild"),
            ("LAUNCHER_BUILD", "launcherBuild"),
        ):
            lines.append(f"{key}={shlex.quote(str(recipe[field]))}")
        lines.append('select_bundle() {\ncase "$OS/$ARCH" in')
        for bundle in bundles:
            lines.append(f"{bundle['os']}/{bundle['arch']})")
            for key, field in (
                ("BUNDLE_URL", "url"),
                ("BUNDLE_SHA", "sha256"),
                ("BUNDLE_BYTES", "bytes"),
                ("EXPANDED_BYTES", "expandedBytes"),
                ("PYTHON_REL", "pythonPath"),
                ("ROOT_REL", "rootPath"),
                ("ROOT_SHA", "rootSha256"),
            ):
                lines.append(f"{key}={shlex.quote(str(bundle[field]))}")
            lines.append(";;")
        lines.append("*) fail UNSUPPORTED_PLATFORM ;;\nesac\n}")
        configuration = "\n".join(lines)
        name = "install.sh"
    else:
        # Single-quoted PowerShell string: apostrophes are escaped, never evaluated.
        configuration = (
            "$Recipe = ConvertFrom-Json '"
            + json.dumps({**recipe, "bundles": bundles}, separators=(",", ":")).replace(
                "'", "''"
            )
            + "'"
        )
        name = "install.ps1"
    text = (templates / name).read_text(encoding="utf-8")
    if text.count("# @@RECIPE@@") != 1:
        raise ValueError("Invalid native bootstrap template")
    return text.replace("# @@RECIPE@@", configuration)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recipe", type=Path)
    parser.add_argument("platform", choices=("posix", "windows"))
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = render_entrypoint(
        json.loads(args.recipe.read_text(encoding="utf-8")), args.platform
    )
    # Refuse accidental overwrite of an already staged entrypoint.
    with args.output.open("x", encoding="utf-8") as output:
        output.write(result)


if __name__ == "__main__":
    main()
