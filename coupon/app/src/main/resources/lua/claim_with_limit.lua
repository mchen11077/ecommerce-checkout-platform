-- Step 3.1 + 3.2 in one round trip: per-user sliding-window rate limit, then the atomic claim.
-- KEYS[1] = coupon:{id}:stock   KEYS[2] = coupon:{id}:users   KEYS[3] = rl:user:{id}
-- ARGV[1] = userId  ARGV[2] = now(ms)  ARGV[3] = window(ms)  ARGV[4] = max  ARGV[5] = unique member
-- Returns 0 = OK, 1 = SOLD_OUT, 2 = ALREADY_CLAIMED, 3 = NOT_ISSUED, 4 = RATE_LIMITED
--
-- NOTE for Redis Cluster: KEYS[1] and KEYS[2] share the coupon hash tag, but KEYS[3] does not,
-- so this script only runs on a standalone Redis. Before moving to Cluster, scope the limiter to
-- the coupon (e.g. {c<id>}:rl:user:<uid>) or keep the two calls separate.
local key = KEYS[3]
local now = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
if redis.call('ZCARD', key) >= tonumber(ARGV[4]) then
  return 4
end
redis.call('ZADD', key, now, ARGV[5])
redis.call('PEXPIRE', key, window)
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then
  return 2
end
local stock = redis.call('GET', KEYS[1])
if not stock then
  return 3
end
if tonumber(stock) <= 0 then
  return 1
end
redis.call('DECR', KEYS[1])
redis.call('SADD', KEYS[2], ARGV[1])
return 0
