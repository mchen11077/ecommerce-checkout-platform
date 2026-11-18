package io.github.mchen11077.ecommerce;

import java.time.Duration;
import org.springframework.stereotype.Service;

/**
 * Phase 1 "naive": the 4 SQL of Step 1.2 - SELECT stock, check user, UPDATE stock = (value read) - 1, INSERT claim.
 *    Read-modify-write with no lock, so concurrent requests oversell (Step 1.3).
 * Phase 2 "lock": same 4 SQL, wrapped in a per-coupon Redis distributed lock (Step 2.1).
 *    Correct, but every request for one coupon is serialised (Step 2.2).
 */
@Service
public class DbClaimService {
    private final DbOps db;
    private final RedisLock lock;

    public DbClaimService(DbOps db, RedisLock lock) {
        this.db = db;
        this.lock = lock;
    }

    public ClaimResult claimNaive(long couponId, long userId) {
        Integer stock = db.queryInt("SELECT stock FROM coupon WHERE id = ?", couponId);
        if (stock == null) {
            return ClaimResult.NOT_FOUND;
        }
        if (stock <= 0) {
            return ClaimResult.SOLD_OUT;
        }
        Integer already = db.queryInt(
                "SELECT COUNT(*) FROM coupon_claim WHERE coupon_id = ? AND user_id = ?", couponId, userId);
        if (already != null && already > 0) {
            return ClaimResult.ALREADY_CLAIMED;
        }
        // Lost update on purpose: writes the value we read earlier, minus one.
        db.update("UPDATE coupon SET stock = ? WHERE id = ?", stock - 1, couponId);
        db.update("INSERT INTO coupon_claim (coupon_id, user_id, source) VALUES (?, ?, 'naive') "
                + "ON CONFLICT (coupon_id, user_id) DO NOTHING", couponId, userId);
        return ClaimResult.OK;
    }

    public ClaimResult claimWithLock(long couponId, long userId) throws InterruptedException {
        String key = "lock:coupon:" + couponId;
        String token = lock.tryLock(key, Duration.ofSeconds(3), Duration.ofSeconds(3));
        if (token == null) {
            return ClaimResult.LOCK_TIMEOUT;
        }
        try {
            return claimNaive(couponId, userId);
        } finally {
            lock.unlock(key, token);
        }
    }
}
