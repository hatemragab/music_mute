# CapRover deployment

Deploy from the **repository root**, using `./captain-definition` as the Captain
Definition Path. It points to `backend/Dockerfile`; CapRover keeps the repository
root as Docker's build context. The root `.dockerignore` allows only backend build
inputs, excluding mobile projects, dotenv files, credentials and local outputs.

The image builds with pinned Node.js 24 on Debian Bookworm, installs only
production dependencies in the runtime stage, runs as the non-root `node` user
and starts `node dist/main.js`. A separate build stage downloads Google's Android
Build Tools 35.0.0 archive directly and verifies its repository-pinned SHA-256
before extraction. Production retains that Build Tools directory and a compatible
Java runtime. Google's Linux Build Tools are AMD64-only, so the CapRover builder
must target Linux AMD64.

To build locally from the repository root on a machine with Docker:

```sh
docker build -f backend/Dockerfile -t musicmute-backend:local .
```

The existing production Compose configuration uses the same build context.
CapRover does not deploy that Compose file automatically.

## Package for dashboard upload

From `backend/`, run:

```sh
npm run package:caprover
```

Upload the printed `api.tar` file through the API app's Deployment tab. Use
`./captain-definition` as the Captain Definition Path. The archive contains the
definition at its root and the build inputs inside `backend/`, matching every
Dockerfile `COPY` path. Packaging includes local source even when it is untracked
in Git, and excludes dotenv files, service-account files, dependencies, mobile
projects and generated output. It does not deploy anything.

If Docker reports `/backend/src` or `/backend/package.json` missing, the uploaded
context is incomplete or has the wrong directory layout. Do not upload only the
Dockerfile or flatten the contents of `backend/` into the archive root. Git-based
deployment also requires all build inputs to exist in the deployed commit; local
untracked files are not included. Use the packaging command for a local upload.

## API app

1. Create the API app in CapRover. Set **Container HTTP Port** to **80**.
   Use CapRover's reverse proxy and enable HTTPS for the app domain. Do not publish
   the container port directly on the host.
2. Set environment variables in **App Configs** using
   [the production example](../.env.production.example) as the key reference.
   Replace placeholders; do not upload a production dotenv file into the image.
3. Keep `APP_ENV=production`, `NODE_ENV=production`, `HOST=0.0.0.0` and `PORT=80`
   (already image defaults). Set `TRUST_PROXY=1` only with CapRover's Nginx as the
   single trusted proxy; additional proxy layers require reviewing the current
   one-hop trust policy.
4. Supply `MONGODB_URI` for Atlas, `AWS_REGION`, `S3_BUCKET`, `FIREBASE_PROJECT_ID`,
   `FIREBASE_WEB_API_KEY`, and a stable `RATE_LIMIT_HASH_SECRET` of at least 32 UTF-8
   bytes. Allow the server egress IP in Atlas and grant its database user permission
   to create collections and indexes. After MongoDB connects, startup awaits the
   Mongoose models so missing schema collections and indexes are created before
   HTTP traffic is accepted. Use [auth operations](auth-operations.md) when you
   need to inspect or apply those definitions manually.
5. Supply `REDIS_URL` for your external Redis service, for example
   `rediss://default:ENCODED_PASSWORD@redis.example.com:6379/0`.
   Production requires a password of at least 16 decoded characters. Use
   `rediss://` for TLS and percent-encode credentials. For an existing private
   CapRover Redis app named `musicmute-redis`, a URL can use
   `redis://default:ENCODED_PASSWORD@srv-captain--musicmute-redis:6379/0`.
   Localhost inside the API container is not the external Redis server.
6. The production install includes the `firebase-admin` runtime package. Provide
   its credential through CapRover without adding `firebase-admin.json` to the
   archive or image. The preferred env-only option is
   `FIREBASE_SERVICE_ACCOUNT_BASE64`, containing the base64-encoded service-account
   JSON; its `project_id` must equal `FIREBASE_PROJECT_ID`. Alternatively, mount an
   externally provisioned credential file read-only, make it readable by the
   `node` user and set `GOOGLE_APPLICATION_CREDENTIALS` to its container path.
   Supply least-privilege AWS credentials through the SDK credential chain or
   CapRover environment variables.

   On macOS, create the value without printing it into the archive:

   ```sh
   base64 < firebase-admin.json | tr -d '\n' | pbcopy
   ```

   Paste the clipboard value into the CapRover environment variable, save the App
   Configs and do not keep the JSON file in the deployment directory.

7. Direct APK verification requires these maintained non-secret values in App
   Configs:

   ```text
   APK_EXPECTED_PACKAGE_ID=com.hatem.musicmute
   APK_TRUSTED_SIGNER_SHA256=<approved lowercase certificate SHA-256>
   ```

   The standard image supplies `APK_AAPT2_PATH`, `APK_APKSIGNER_PATH` and
   `APK_MAX_MIN_SDK=26`. Do not derive the package or signer from an upload.

Native clients can leave `CORS_ORIGINS` empty. Browser clients need exact HTTPS
origins. Never set production emulator variables.

The S3 bucket needs a separate CORS rule for each deployed dashboard origin.
Apply an operator-reviewed equivalent of this configuration, replacing the
placeholder with the exact HTTPS origin:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://<dashboard-host>"],
      "AllowedMethods": ["PUT"],
      "AllowedHeaders": [
        "Content-Type",
        "x-amz-checksum-sha256",
        "If-None-Match"
      ],
      "MaxAgeSeconds": 300
    }
  ]
}
```

Direct APK download grants are private, version-pinned and short-lived. A future
CDN/private-origin migration, bucket-policy update, lifecycle edit, and credential
rotation are operator-owned infrastructure work: validate them in an authorized
sandbox and deployment change. Application builds and archive packaging do not
apply any AWS, CDN, DNS, CapRover, Firebase or credential mutation.

## External Redis

Redis is managed independently from this app and stores shared rate limits and
mail budgets. Configure authentication, persistence and `maxmemory-policy noeviction`
on that service so restarts and eviction do not silently reset security counters.
Keep its port private and enable TLS when connecting across an untrusted network.
Back up persistent data; rebuilding the API must not recreate Redis storage.

Deploy only the API. The worker entry point and BullMQ queue have been removed.
Before upgrading, configure `REDIS_URL` in App Configs; the old `REDIS_HOST`,
`REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_TLS` and `QUEUE_PREFIX` settings are unused.
If an old worker app exists, stop it separately during the rollout. This source
change does not stop deployed services or remove existing Redis data.

## Verify after deployment

Check `/api/v1/health/live` and `/api/v1/health/ready` on the HTTPS app domain.
Readiness verifies MongoDB and Redis; it does not verify Firebase or S3 access.
Inspect startup logs for index/configuration failures, check restart behavior,
and verify client IP handling before relying on IP-based rate limits.

CapRover resource limits, mounts and shutdown grace periods are configured
separately; settings from `compose.production.yaml` are not imported.

References: [Captain definition](https://caprover.com/docs/captain-definition-file.html),
[app configuration](https://caprover.com/docs/app-configuration.html).
