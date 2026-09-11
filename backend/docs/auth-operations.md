# Authentication operations

Build the backend before using the operator CLI. Select the intended environment
with `APP_ENV=local` or with both `APP_ENV=production` and
`NODE_ENV=production`; configuration is loaded through the
same validated environment boundary as the API. The CLI imports configuration,
MongoDB, and the three auth data models only. It does not start HTTP, Redis,
S3, or Firebase Admin.

Run every potentially mutating operation in dry-run mode first. Apply mode is
accepted only through the explicit `--apply` flag. Errors contain safe operation
codes and never echo the MongoDB URI, credentials, file contents, or SDK errors.

## Required indexes

The authentication feature uses these exact indexes:

| Collection     | Name                                | Keys                                             | Options            |
| -------------- | ----------------------------------- | ------------------------------------------------ | ------------------ |
| `users`        | `users_firebase_uid_unique`         | `{ firebaseUid: 1 }`                             | `{ unique: true }` |
| `user_devices` | `devices_owner_installation_unique` | `{ userId: 1, installationId: 1 }`               | `{ unique: true }` |
| `user_devices` | `devices_owner_cursor`              | `{ userId: 1, _id: -1 }`                         | none               |
| `user_devices` | `devices_recent_versions`           | `{ lastSeenAt: 1, platform: 1, buildNumber: 1 }` | none               |

Inspect definitions and duplicate identity counts without writing:

```sh
npm run ops:auth -- indexes --dry-run
```

After reviewing a clean inspection, create only missing required indexes:

```sh
npm run ops:auth -- indexes --apply
```

Apply refuses duplicate identity records and any index with a conflicting name,
key order, uniqueness, sparse, partial-filter, or collation definition. It never
drops or rewrites an index, collection, user, or device. Resolve conflicts and
duplicates through a separately reviewed data procedure before retrying.

API startup awaits Mongoose model initialization after connecting to MongoDB, so
missing collections and indexes declared by the schemas are created before the
API accepts traffic in every environment. Startup still fails if MongoDB refuses
an index build, including insufficient permissions or duplicate values for a
unique index. The explicit operator command remains useful for inspecting all
definitions and duplicate identity counts before a rollout.

## Application policy

The policy file is a JSON patch containing only `requireVerifiedEmail` and/or
partial `platforms.android` and `platforms.ios` fields. The CLI rejects `_id`,
`revision`, `updatedAt`, unknown fields, invalid builds, and unsafe download URLs.
It merges the patch with the current policy and validates the complete result.

Example `policy.json`:

```json
{
  "requireVerifiedEmail": true,
  "platforms": {
    "ios": {
      "minimumBuild": 10,
      "latestBuild": 12,
      "downloadUrl": "https://apps.example.com/musicmute"
    }
  }
}
```

Preview revision `4` without writing, then apply that exact compare-and-set:

```sh
npm run ops:auth -- policy --dry-run --file ./policy.json --expected-revision 4
npm run ops:auth -- policy --apply --file ./policy.json --expected-revision 4
```

Missing policy storage uses the optional-verification default at revision `0` and
does not require a seed write. Apply increments the revision atomically. A stale
expected revision returns `POLICY_REVISION_CONFLICT` and writes nothing.

## Recent installation statistics

The default activity window is 30 days; an explicit value must be an integer from
1 through 365:

```sh
npm run ops:auth -- stats
npm run ops:auth -- stats --days 30
```

Output contains recent installation records and distinct MongoDB user counts,
both as totals and grouped by platform, app version, and build number. Installation
records are self-reported app installations and must not be described as physical
devices. The command returns counts only; it does not expose installation IDs,
user IDs, emails, or Firebase UIDs.
