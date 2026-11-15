import type { AppPolicy } from './app-policy.schema.js';
export function presentPolicy(policy: AppPolicy) {
  const platform = (value: AppPolicy['platforms']['android']) => ({
    minimumBuild: value.minimumBuild,
  });
  return {
    requireVerifiedEmail: policy.requireVerifiedEmail,
    platforms: {
      android: platform(policy.platforms.android),
      ios: platform(policy.platforms.ios),
    },
    revision: policy.revision,
    updatedAt: policy.updatedAt,
  };
}
