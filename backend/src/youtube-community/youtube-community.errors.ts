import { HttpException } from '@nestjs/common';

const errors = {
  YOUTUBE_CONTRIBUTION_NOT_FOUND: [404, 'Contribution not found'],
  YOUTUBE_CONTRIBUTION_CONFLICT: [409, 'Contribution state has changed'],
  YOUTUBE_CONTRIBUTION_EXPIRED: [410, 'Contribution reservation expired'],
  YOUTUBE_COMMUNITY_CAPACITY: [429, 'Community contribution capacity is full'],
  YOUTUBE_COMMUNITY_BYTE_LIMIT: [429, 'Community media allowance is exhausted'],
} as const;
export function communityError(code: keyof typeof errors): HttpException {
  const [statusCode, message] = errors[code];
  return new HttpException({ statusCode, code, message }, statusCode);
}
