import { User, UserSchema } from '../../dist/users/user.schema.js';
import { AccountAccessService } from '../../dist/users/account-access.service.js';
import {
  UserIdentityFence,
  UserIdentityFenceSchema,
} from '../../dist/users/user-identity-fence.schema.js';
import { UserIdentityFenceService } from '../../dist/users/user-identity-fence.service.js';

export async function accountFixture(connection, ids = []) {
  const users =
    connection.models[User.name] ?? connection.model(User.name, UserSchema);
  const fences =
    connection.models[UserIdentityFence.name] ??
    connection.model(UserIdentityFence.name, UserIdentityFenceSchema);
  await Promise.all([users.init(), fences.init()]);
  for (const id of ids)
    await users.create({
      _id: id,
      firebaseUid: `fixture-${id}`,
      displayName: 'Fixture',
      nameSource: 'numeric_alias',
      profileSyncedAt: new Date(),
      lastSeenAt: new Date(),
    });
  return {
    users,
    fences,
    access: new AccountAccessService(users),
    identities: new UserIdentityFenceService(fences),
  };
}
