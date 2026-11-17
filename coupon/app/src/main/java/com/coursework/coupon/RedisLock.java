package com.coursework.coupon;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

/** Simple Redis distributed lock: SET key token NX PX, released with compare-and-delete. */
@Component
public class RedisLock {
    private static final DefaultRedisScript<Long> UNLOCK = new DefaultRedisScript<>(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
            Long.class);

    private final StringRedisTemplate redis;

    public RedisLock(StringRedisTemplate redis) {
        this.redis = redis;
    }

    /** Returns the lock token, or null if the lock was not acquired within {@code wait}. */
    public String tryLock(String key, Duration ttl, Duration wait) throws InterruptedException {
        String token = UUID.randomUUID().toString();
        long deadline = System.nanoTime() + wait.toNanos();
        do {
            if (Boolean.TRUE.equals(redis.opsForValue().setIfAbsent(key, token, ttl))) {
                return token;
            }
            Thread.sleep(2);
        } while (System.nanoTime() < deadline);
        return null;
    }

    public void unlock(String key, String token) {
        redis.execute(UNLOCK, List.of(key), token);
    }
}
