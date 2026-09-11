export const QUOTA_RESERVATION_SCRIPT = `
local stamp = redis.call('TIME')
local now = tonumber(stamp[1]) * 1000 + math.floor(tonumber(stamp[2]) / 1000)
local retryMs = 0

for i, key in ipairs(KEYS) do
  local window = tonumber(ARGV[i * 2])
  local limit = tonumber(ARGV[i * 2 + 1])
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
  local count = redis.call('ZCARD', key)
  if count >= limit then
    local rank = count - limit
    local expiresNextSlot = redis.call('ZRANGE', key, rank, rank, 'WITHSCORES')
    retryMs = math.max(retryMs, tonumber(expiresNextSlot[2]) + window - now)
  end
end

if retryMs > 0 then
  return {0, math.ceil(retryMs / 1000)}
end

for i, key in ipairs(KEYS) do
  local window = tonumber(ARGV[i * 2])
  redis.call('ZADD', key, now, ARGV[1])
  redis.call('PEXPIRE', key, window + 1000)
end

return {1, 0}
`;
