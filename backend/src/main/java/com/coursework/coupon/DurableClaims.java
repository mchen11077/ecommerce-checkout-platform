package com.coursework.coupon;

import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

@Service
class DurableClaims {
    private record Offer(String status, int stock, boolean notStarted, boolean expired) {}

    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;

    DurableClaims(JdbcTemplate jdbc, TransactionTemplate transactions) {
        this.jdbc = jdbc;
        this.transactions = transactions;
    }

    Map<String, Object> issue(long couponId) {
        var rows = jdbc.query("""
                UPDATE coupon SET status = 'ACTIVE' WHERE id = ? RETURNING stock
                """, (row, index) -> row.getInt("stock"), couponId);
        if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Coupon not found");
        return Map.of("id", couponId, "status", "ACTIVE", "stock", rows.getFirst());
    }

    ClaimResult claim(long couponId, long userId) {
        return transactions.execute(transaction -> {
            var offers = jdbc.query("""
                    SELECT status, stock, now() < valid_from AS not_started, now() > valid_until AS expired
                    FROM coupon WHERE id = ? FOR NO KEY UPDATE
                    """, (row, index) -> new Offer(row.getString("status"), row.getInt("stock"),
                    row.getBoolean("not_started"), row.getBoolean("expired")), couponId);
            if (offers.isEmpty()) return ClaimResult.NOT_FOUND;

            Offer offer = offers.getFirst();
            if (!"ACTIVE".equals(offer.status())) return ClaimResult.NOT_ISSUED;
            if (offer.notStarted()) return ClaimResult.NOT_STARTED;
            if (offer.expired()) return ClaimResult.EXPIRED;

            Boolean alreadyClaimed = jdbc.queryForObject("""
                    SELECT EXISTS (SELECT 1 FROM coupon_claim WHERE coupon_id = ? AND user_id = ?)
                    """, Boolean.class, couponId, userId);
            if (Boolean.TRUE.equals(alreadyClaimed)) return ClaimResult.ALREADY_CLAIMED;
            if (offer.stock() <= 0) return ClaimResult.SOLD_OUT;

            jdbc.update("INSERT INTO coupon_claim (coupon_id, user_id, source) VALUES (?, ?, 'postgres')",
                    couponId, userId);
            jdbc.update("UPDATE coupon SET stock = stock - 1 WHERE id = ?", couponId);
            return ClaimResult.OK;
        });
    }
}
