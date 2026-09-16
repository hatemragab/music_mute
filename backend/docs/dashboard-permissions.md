# Dashboard permissions

Navigation may use this matrix, but every decision is enforced by the API. Refresh `GET /api/v1/admin/session` after foregrounding, token refresh or a role change, and clear privileged state when admission fails.

| Permission                      | Owner | Release manager | Support | Viewer |
| ------------------------------- | :---: | :-------------: | :-----: | :----: |
| `overview.read`                 |  yes  |       yes       |   yes   |  yes   |
| `jobs.read`                     |  yes  |                 |   yes   |  yes   |
| `jobs.manage`                   |  yes  |                 |   yes   |        |
| `users.read`                    |  yes  |                 |   yes   |        |
| `users.processing.manage`       |  yes  |                 |   yes   |        |
| `users.account-recovery.manage` |  yes  |                 |   yes   |        |
| `media.read`                    |  yes  |                 |   yes   |        |
| `releases.read`                 |  yes  |       yes       |         |  yes   |
| `releases.manage`               |  yes  |       yes       |         |        |
| `settings.read`                 |  yes  |                 |   yes   |  yes   |
| `settings.manage`               |  yes  |                 |         |        |
| `health.read`                   |  yes  |                 |         |        |
| `alerts.manage`                 |  yes  |                 |         |        |
| `audit.read`                    |  yes  |                 |         |        |
| `exports.read`                  |  yes  |                 |   yes   |        |
| `admin.access.manage`           |  yes  |                 |         |        |

Media grants need both `jobs.read` and `media.read`; jobs export needs `exports.read` and `jobs.read`; overview export needs `exports.read` and `overview.read`. Overview includes release counts only with `releases.read`.

Fresh Google authentication is additionally required for access grants/changes, media grants, account-recovery approval/rejection, user processing suspension/resumption, processing settings writes, and release publication/withdrawal. Fresh authentication adds no permission.

Owners can inspect another actor's operation receipt with `actorUid`; other roles can inspect only their own. Only owners manage administrator access, and the backend preserves one active owner. Support can resume processing without changing an account's disabled/deleting state.

Media and upload grants are temporary. Audit events, receipts and ordinary resource reads omit those values.
