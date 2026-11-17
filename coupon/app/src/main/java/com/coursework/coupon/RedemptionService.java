package com.coursework.coupon;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Step 1.1: eligibility validation and redemption. These run against PostgreSQL (the system of record);
 * they are not on the flash-sale hot path, so the claim experiments are unchanged.
 *
 * Note: a claim accepted on the Redis path only appears here after the Kafka consumer has persisted it
 * (eventual consistency), so a user who claimed a moment ago can briefly see NOT_CLAIMED.
 */
@Service
public class RedemptionService {

    public enum Eligibility {
        ELIGIBLE(200), COUPON_NOT_FOUND(404), NOT_ISSUED(409), NOT_STARTED(409), EXPIRED(409),
        NOT_CLAIMED(409), ALREADY_REDEEMED(409), BELOW_MIN_ORDER(409), REDEEMED(200);

        public final int httpStatus;

        Eligibility(int httpStatus) {
            this.httpStatus = httpStatus;
        }
    }

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;

    public RedemptionService(JdbcTemplate jdbc, TransactionTemplate tx) {
        this.jdbc = jdbc;
        this.tx = tx;
    }

    public Eligibility check(long couponId, long userId, BigDecimal orderAmount) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT c.status AS coupon_status, c.min_order_amount, "
                        + "       now() < c.valid_from  AS not_started, "
                        + "       now() > c.valid_until AS expired, "
                        + "       cc.status AS claim_status "
                        + "FROM coupon c "
                        + "LEFT JOIN coupon_claim cc ON cc.coupon_id = c.id AND cc.user_id = ? "
                        + "WHERE c.id = ?", userId, couponId);
        if (rows.isEmpty()) {
            return Eligibility.COUPON_NOT_FOUND;
        }
        Map<String, Object> r = rows.get(0);
        return decide(
                (String) r.get("coupon_status"),
                Boolean.TRUE.equals(r.get("not_started")),
                Boolean.TRUE.equals(r.get("expired")),
                (String) r.get("claim_status"),
                (BigDecimal) r.get("min_order_amount"),
                orderAmount);
    }

    /**
     * The eligibility decision, deliberately free of JDBC so it can be unit-tested without a database.
     * Row lookup is the caller's job; this only answers "given these facts, which outcome?".
     * Order matters: a coupon that expired wins over "not claimed", and an already redeemed claim wins
     * over the order amount, so the user is told the real reason.
     */
    static Eligibility decide(
            String couponStatus,
            boolean notStarted,
            boolean expired,
            String claimStatus,
            BigDecimal minOrderAmount,
            BigDecimal orderAmount) {
        if (!"ACTIVE".equals(couponStatus)) {
            return Eligibility.NOT_ISSUED;
        }
        if (notStarted) {
            return Eligibility.NOT_STARTED;
        }
        if (expired) {
            return Eligibility.EXPIRED;
        }
        if (claimStatus == null) {
            return Eligibility.NOT_CLAIMED;
        }
        if ("REDEEMED".equals(claimStatus)) {
            return Eligibility.ALREADY_REDEEMED;
        }
        if (minOrderAmount != null && orderAmount.compareTo(minOrderAmount) < 0) {
            return Eligibility.BELOW_MIN_ORDER;
        }
        return Eligibility.ELIGIBLE;
    }

    /**
     * PostgreSQL rechecks the use limit after waiting for a concurrent update to the same claim.
     * Recording the order in the same transaction prevents retries from spending another use.
     */
    public Eligibility redeem(long couponId, long userId, BigDecimal orderAmount, String orderId) {
        return tx.execute(status -> {
            jdbc.queryForList("""
                    SELECT id FROM coupon_claim WHERE coupon_id = ? AND user_id = ? FOR UPDATE
                    """, Long.class, couponId, userId);
            Eligibility e = check(couponId, userId, orderAmount);
            if (e != Eligibility.ELIGIBLE) {
                return e;
            }
            Boolean alreadyUsed = jdbc.queryForObject("""
                    SELECT EXISTS (SELECT 1 FROM coupon_redemption
                                   WHERE coupon_id = ? AND user_id = ? AND order_id = ?)
                    """, Boolean.class, couponId, userId, orderId);
            if (Boolean.TRUE.equals(alreadyUsed)) return Eligibility.ALREADY_REDEEMED;
            int updated = jdbc.update(
                    """
                    UPDATE coupon_claim cc
                    SET use_count = cc.use_count + 1,
                        status = CASE WHEN cc.use_count + 1 = c.max_uses_per_user
                                      THEN 'REDEEMED' ELSE 'CLAIMED' END,
                        redeemed_at = now(), order_id = ?
                    FROM coupon c
                    WHERE c.id = cc.coupon_id AND cc.coupon_id = ? AND cc.user_id = ?
                      AND cc.status = 'CLAIMED' AND cc.use_count < c.max_uses_per_user
                      AND c.status = 'ACTIVE' AND now() BETWEEN c.valid_from AND c.valid_until
                      AND ? >= c.min_order_amount
                    """, orderId, couponId, userId, orderAmount);
            if (updated == 0) return Eligibility.ALREADY_REDEEMED;
            jdbc.update("""
                    INSERT INTO coupon_redemption (coupon_id, user_id, order_id)
                    VALUES (?, ?, ?)
                    """, couponId, userId, orderId);
            return Eligibility.REDEEMED;
        });
    }
}
