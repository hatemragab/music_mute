"""Stable launcher entrypoint; no GPU dependencies are imported."""

from .launcher import main

if __name__ == "__main__":
    raise SystemExit(main())
