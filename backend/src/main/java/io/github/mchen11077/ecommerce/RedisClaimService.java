package io.github.mchen11077.ecommerce;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

/**
 * Phase 3 "redis": stock and claimed-user set preloaded into Redis, claim is one atomic Lua script (Step 3.1),
 * per-user sliding-window rate limit with a sorted set (Step 3.2). No SQL on the synchronous path (Step 3.3);
 * the claim is published to Kafka (Step 4.1) and persisted asynchronously (Step 4.2).
 *
 * Hot-path variant (default on): the rate-limit check and the claim are merged into one Lua call, saving one
 * network round trip per request. Set coupon.rate-limit.combined=false to run the two-call version for A/B.
 */
@Service
public class RedisClaimService {
    public static final String TOPIC = "coupon-claimed";
    private static final Logger log = LoggerFactory.getLogger(RedisClaimService.class);

    private final StringRedisTemplate redis;
    private final KafkaTemplate<String, String> kafka;
    private final ObjectMapper mapper;
    private final DefaultRedisScript<Long> claimWithLimitScript = script("lua/claim_with_limit.lua");
    private final DefaultRedisScript<Long> claimScript = script("lua/claim.lua");
    private final DefaultRedisScript<Long> rateLimitScript = script("lua/rate_limit.lua");

    @Value("${coupon.rate-limit.max-per-window}")
    private int maxPerWindow;

    @Value("${coupon.rate-limit.window-ms}")
    private long windowMs;

    @Value("${coupon.rate-limit.combined:true}")
    private boolean combinedRateLimit;

    /** coupon = keep every event of one coupon on one partition; user = spread a hot coupon over all partitions. */
    @Value("${coupon.kafka.key-mode:user}")
    private String kafkaKeyMode;

    public RedisClaimService(StringRedisTemplate redis, KafkaTemplate<String, String> kafka, ObjectMapper mapper) {
        this.redis = redis;
        this.kafka = kafka;
        this.mapper = mapper;
    }

    private static DefaultRedisScript<Long> script(String path) {
        DefaultRedisScript<Long> s = new DefaultRedisScript<>();
        s.setLocation(new ClassPathResource(path));
        s.setResultType(Long.class);
        return s;
    }

    static String stockKey(long couponId) {
        return "coupon:" + couponId + ":stock";
    }

    static String usersKey(long couponId) {
        return "coupon:" + couponId + ":users";
    }

    public void preload(long couponId, int stock) {
        redis.delete(usersKey(couponId));
        redis.opsForValue().set(stockKey(couponId), String.valueOf(stock));
    }

    public ClaimResult claim(long couponId, long userId) throws Exception {
        long now = System.currentTimeMillis();
        String member = now + ":" + ThreadLocalRandom.current().nextLong();
        if (combinedRateLimit) {
            Long r = redis.execute(claimWithLimitScript,
                    List.of(stockKey(couponId), usersKey(couponId), "rl:user:" + userId),
                    String.valueOf(userId), String.valueOf(now), String.valueOf(windowMs),
                    String.valueOf(maxPerWindow), member);
            return translate(couponId, userId, require(r));
        }
        if (!allow(userId, now, member)) {
            return ClaimResult.RATE_LIMITED;
        }
        Long r = redis.execute(claimScript, List.of(stockKey(couponId), usersKey(couponId)), String.valueOf(userId));
        return translate(couponId, userId, require(r));
    }

    private static long require(Long r) {
        if (r == null) {
            throw new IllegalStateException("Lua script returned null");
        }
        return r;
    }

    private ClaimResult translate(long couponId, long userId, long code) throws Exception {
        switch ((int) code) {
            case 0:
                publish(couponId, userId);
                return ClaimResult.OK;
            case 1:
                return ClaimResult.SOLD_OUT;
            case 2:
                return ClaimResult.ALREADY_CLAIMED;
            case 3:
                return ClaimResult.NOT_ISSUED;
            case 4:
                return ClaimResult.RATE_LIMITED;
            default:
                throw new IllegalStateException("Unexpected Lua result " + code);
        }
    }

    private boolean allow(long userId, long now, String member) {
        Long ok = redis.execute(rateLimitScript, List.of("rl:user:" + userId),
                String.valueOf(now), String.valueOf(windowMs), String.valueOf(maxPerWindow), member);
        return ok != null && ok == 1L;
    }

    private void publish(long couponId, long userId) throws Exception {
        String payload = mapper.writeValueAsString(Map.of(
                "couponId", couponId, "userId", userId, "ts", System.currentTimeMillis()));
        // The consumer is idempotent and the stock decrement is commutative, so per-coupon ordering is not
        // needed. Keying by userId spreads one hot coupon over all 12 partitions; keying by couponId puts
        // every event of that coupon on one partition and leaves the other consumer threads idle.
        String key = "coupon".equalsIgnoreCase(kafkaKeyMode)
                ? String.valueOf(couponId) : String.valueOf(userId);
        kafka.send(TOPIC, key, payload).whenComplete((res, ex) -> {
            if (ex != null) {
                // Phase 5: this claim is now in Redis but may never reach PostgreSQL.
                // Production fix: transactional outbox, or a reconciliation job that re-publishes missing claims.
                log.error("Failed to publish claim event {}", payload, ex);
            }
        });
    }
}
