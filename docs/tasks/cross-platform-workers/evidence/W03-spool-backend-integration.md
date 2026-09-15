# W03 spool and backend integration

Date: 2026-09-14. Local isolated integration passed; independent W03 review pending.

`backend/test/worker-spool.integration.mjs` runs the real Python spool and control
client against actual Nest controllers/authentication and isolated MongoDB/Redis.
`backend/test/helpers/worker-spool-client.py` is the child-process transport adapter.

The first Python process has a clock 24 hours ahead. It persists an installation
failure, reads authenticated setup server time, and submits it. The backend accepts
the event; the adapter then simulates a lost response. The pending spool survives.
The fixture expires the setup token and starts a new Python process with a clock
24 hours behind and the installation's current permanent credential. It reads the
permanent update-policy clock and retries the identical payload. The backend
returns a duplicate receipt and the spool clears the pending event.

Assertions cover identical request payload hashes across restart and credential
scope, exactly one database row, corrected occurrence time, redacted diagnostics,
and unchanged receipt time and exact receipt-plus-30-day expiry. Processing is
disabled throughout, exercising processing-independent reporting.

Executed from `backend`:

```sh
MUSICMUTE_TEST_PYTHON=/tmp/musicmute-w03-launcher-lock-check/bin/python node --test test/worker-spool.integration.mjs
npx prettier --check test/worker-spool.integration.mjs
npx oxlint --deny-warnings test/worker-spool.integration.mjs
```

Integration: one test passed, zero failures/skips, exit 0. Formatting and lint
passed. From the repository root, these also passed:

```sh
uvx ruff format --check backend/test/helpers/worker-spool-client.py
uvx ruff check --select F,E9 backend/test/helpers/worker-spool-client.py
```

The injected transport maps only a synthetic HTTPS origin to isolated loopback
HTTP. Product transport remains HTTPS-only; this is not TLS validation. The
fixture uses a previously paired isolated installation and changes credential
scope between processes; it is not a real user pairing or GPU/service test.
Initial fixture corrections supplied a test Firebase project identifier,
canonicalized macOS temporary paths and parsed the stored occurrence string.
No product repair was needed for this scenario. No live services or credentials
were used.
