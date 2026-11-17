-- Step 3.1 atomic claim: check duplicate -> check stock -> decrement -> record user.
-- KEYS[1] = coupon:{id}:stock   KEYS[2] = coupon:{id}:users   ARGV[1] = userId
-- Returns 0 = OK, 1 = SOLD_OUT, 2 = ALREADY_CLAIMED, 3 = NOT_ISSUED (coupon not loaded into Redis)
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
