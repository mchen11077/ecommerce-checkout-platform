-- Step 3.2: per-user sliding-window rate limit with a sorted set.
-- KEYS[1] = rl:user:{id}  ARGV[1] = now(ms)  ARGV[2] = window(ms)  ARGV[3] = max  ARGV[4] = unique member
-- Returns 1 = allowed, 0 = rejected
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
if redis.call('ZCARD', key) >= tonumber(ARGV[3]) then
  return 0
end
redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, window)
return 1
