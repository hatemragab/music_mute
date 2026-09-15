/** Fixed windows anchored to first admission; one counter per bucket, never per byte.
 * Inspect every bucket before writing any, so rate and byte admission is atomic.
 * Use dedicated keys: ordinary sliding-window reservation keys remain sorted sets.
 */
export const WEIGHTED_QUOTA_SCRIPT = `
local retryMs = 0
for i, key in ipairs(KEYS) do
  local window = tonumber(ARGV[i * 3 - 2])
  local limit = tonumber(ARGV[i * 3 - 1])
  local weight = tonumber(ARGV[i * 3])
  local used = tonumber(redis.call('GET', key) or '0')
  if used + weight > limit then
    local ttl = redis.call('PTTL', key)
    retryMs = math.max(retryMs, ttl > 0 and ttl or window)
  end
end
if retryMs > 0 then return {0, math.ceil(retryMs / 1000)} end
for i, key in ipairs(KEYS) do
  local window = tonumber(ARGV[i * 3 - 2])
  local weight = tonumber(ARGV[i * 3])
  local value = redis.call('INCRBY', key, weight)
  if value == weight then redis.call('PEXPIRE', key, window) end
end
return {1, 0}
`;
