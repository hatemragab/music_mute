import type { UserDocument } from './user.schema.js';

export function presentUser(user: UserDocument) {
  return {
    id: user._id.toHexString(),
    displayName: user.displayName,
    email: user.email,
    emailVerified: user.emailVerified,
    providers: [...user.providerIds],
  };
}
