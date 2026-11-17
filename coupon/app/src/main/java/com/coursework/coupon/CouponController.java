package com.coursework.coupon;

import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Step 1.1 lifecycle: create -> issue -> claim -> eligibility -> redeem.
 * The claim endpoint has three implementations selected by ?mode= (Phase 1 / 2 / 3).
 */
@RestController
@RequestMapping("/api")
public class CouponController {
    private final JdbcTemplate jdbc;
    private final StringRedisTemplate redis;
    private final DbOps db;
    private final DbClaimService dbClaims;
    private final RedisClaimService redisClaims;
    private final RedemptionService redemption;
    private final ClaimEventConsumer consumer;
    private final DurableClaims durableClaims;

    @Value("${coupon.claim.durable:false}")
    private boolean durableClaimMode;

    public CouponController(JdbcTemplate jdbc, StringRedisTemplate redis, DbOps db, DbClaimService dbClaims,
                            RedisClaimService redisClaims, RedemptionService redemption,
                            ClaimEventConsumer consumer, DurableClaims durableClaims) {
        this.jdbc = jdbc;
        this.redis = redis;
        this.db = db;
        this.dbClaims = dbClaims;
        this.redisClaims = redisClaims;
        this.redemption = redemption;
        this.consumer = consumer;
        this.durableClaims = durableClaims;
    }

    public record ListedCoupon(long id, String name, BigDecimal minOrderAmount, BigDecimal discountAmount,
                               OffsetDateTime validFrom, OffsetDateTime validUntil, String giftName, Integer remainingStock,
                               int maxUsesPerUser) {}

    public record WalletCoupon(ListedCoupon coupon, String status, int remainingUses) {}

    private ListedCoupon readCoupon(ResultSet row) throws SQLException {
        return new ListedCoupon(row.getLong("id"), row.getString("name"), row.getBigDecimal("min_order_amount"),
                row.getBigDecimal("discount_amount"), row.getObject("valid_from", OffsetDateTime.class),
                row.getObject("valid_until", OffsetDateTime.class), row.getString("gift_name"),
                durableClaimMode ? row.getInt("stock") : null, row.getInt("max_uses_per_user"));
    }

    @GetMapping("/coupons")
    public List<ListedCoupon> list() {
        return jdbc.query("""
                SELECT id, name, min_order_amount, discount_amount, valid_from, valid_until, gift_name, stock, max_uses_per_user
                FROM coupon
                WHERE status = 'ACTIVE' AND valid_from <= CURRENT_TIMESTAMP
                  AND valid_until >= CURRENT_TIMESTAMP
                ORDER BY id DESC
                LIMIT 50
                """, (row, index) -> readCoupon(row));
    }

    @GetMapping("/users/{userId}/coupons")
    public List<WalletCoupon> wallet(@PathVariable long userId) {
        return jdbc.query("""
                SELECT c.id, c.name, c.min_order_amount, c.discount_amount, c.valid_from, c.valid_until, c.gift_name, c.stock,
                       c.max_uses_per_user,
                       CASE WHEN cc.status = 'REDEEMED' THEN 0
                            ELSE c.max_uses_per_user - cc.use_count END AS remaining_uses,
                       CASE WHEN cc.status = 'REDEEMED' THEN 'REDEEMED'
                            WHEN c.valid_until < CURRENT_TIMESTAMP THEN 'EXPIRED'
                            WHEN c.valid_from > CURRENT_TIMESTAMP THEN 'UPCOMING'
                            ELSE 'AVAILABLE' END AS wallet_status
                FROM coupon_claim cc
                JOIN coupon c ON c.id = cc.coupon_id
                WHERE cc.user_id = ?
                ORDER BY cc.id DESC
                """, (row, index) -> new WalletCoupon(readCoupon(row), row.getString("wallet_status"),
                        row.getInt("remaining_uses")), userId);
    }

    /** Create (status DRAFT). Optional: minOrderAmount, validFrom, validUntil (ISO-8601, e.g. 2026-11-04T08:00:00Z). */
    @PostMapping("/coupons")
    public Map<String, Object> create(@RequestBody Map<String, Object> body) {
        Object label = body.getOrDefault("name", "coupon");
        if (!(label instanceof String name) || name.isBlank() || name.length() > 160) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid name");
        }
        int stock;
        try {
            stock = new BigDecimal(String.valueOf(body.get("stock"))).intValueExact();
            if (stock < 0) throw new ArithmeticException();
        } catch (NumberFormatException | ArithmeticException exception) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid stock");
        }
        BigDecimal minOrder = couponAmount(body, "minOrderAmount");
        BigDecimal discount = couponAmount(body, "discountAmount");
        int maxUsesPerUser;
        try {
            maxUsesPerUser = new BigDecimal(String.valueOf(body.getOrDefault("maxUsesPerUser", 1))).intValueExact();
            if (maxUsesPerUser < 1) throw new ArithmeticException();
        } catch (NumberFormatException | ArithmeticException exception) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid maxUsesPerUser");
        }
        String giftName = null;
        if (body.get("giftName") != null) {
            if (!(body.get("giftName") instanceof String gift) || gift.isBlank() || gift.strip().length() > 120) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid giftName");
            }
            giftName = gift.strip();
        }
        OffsetDateTime now = OffsetDateTime.now();
        OffsetDateTime from;
        OffsetDateTime until;
        try {
            from = body.get("validFrom") == null ? now : OffsetDateTime.parse(String.valueOf(body.get("validFrom")));
            until = body.get("validUntil") == null ? now.plusDays(30)
                    : OffsetDateTime.parse(String.valueOf(body.get("validUntil")));
        } catch (DateTimeParseException exception) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid validity timestamp");
        }
        if (until.isBefore(from)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "validUntil precedes validFrom");
        }
        Long id = jdbc.queryForObject(
                """
                INSERT INTO coupon (name, total_stock, stock, min_order_amount, discount_amount, valid_from,
                                    valid_until, gift_name, max_uses_per_user)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
                """, Long.class, name, stock, stock, minOrder, discount, from, until, giftName, maxUsesPerUser);
        return Map.of("id", id, "stock", stock, "status", "DRAFT");
    }

    private static BigDecimal couponAmount(Map<String, Object> body, String field) {
        try {
            var amount = new BigDecimal(String.valueOf(body.getOrDefault(field, "0")));
            if (amount.signum() < 0 || amount.compareTo(new BigDecimal("99999999.99")) > 0) {
                throw new ArithmeticException();
            }
            return amount.setScale(2);
        } catch (NumberFormatException | ArithmeticException exception) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid " + field);
        }
    }

    /** Issue (发放): mark ACTIVE and load stock into Redis so it can be claimed. */
    @PostMapping({"/coupons/{id}/issue", "/coupons/{id}/preload"})
    public Map<String, Object> issue(@PathVariable long id) {
        if (durableClaimMode) return durableClaims.issue(id);
        jdbc.update("UPDATE coupon SET status = 'ACTIVE' WHERE id = ?", id);
        Integer stock = jdbc.queryForObject("SELECT stock FROM coupon WHERE id = ?", Integer.class, id);
        redisClaims.preload(id, stock);
        return Map.of("id", id, "status", "ACTIVE", "redisStock", stock);
    }

    @PostMapping("/coupons/{id}/claim")
    public ResponseEntity<Map<String, String>> claim(@PathVariable long id,
                                                     @RequestParam long userId,
                                                     @RequestParam(defaultValue = "redis") String mode) throws Exception {
        ClaimResult result = durableClaimMode ? durableClaims.claim(id, userId) : switch (mode) {
            case "naive" -> dbClaims.claimNaive(id, userId);
            case "lock" -> dbClaims.claimWithLock(id, userId);
            default -> redisClaims.claim(id, userId);
        };
        return ResponseEntity.status(result.httpStatus).body(Map.of("result", result.name()));
    }

    /** Eligibility validation (资格校验): can this user use this coupon on an order of this amount right now? */
    @GetMapping("/coupons/{id}/eligibility")
    public ResponseEntity<Map<String, String>> eligibility(@PathVariable long id, @RequestParam long userId,
                                                           @RequestParam BigDecimal orderAmount) {
        RedemptionService.Eligibility e = redemption.check(id, userId, orderAmount);
        return ResponseEntity.status(e.httpStatus).body(Map.of("result", e.name()));
    }

    /** Redeem one use for this order. */
    @PostMapping("/coupons/{id}/redeem")
    public ResponseEntity<Map<String, String>> redeem(@PathVariable long id, @RequestParam long userId,
                                                      @RequestParam BigDecimal orderAmount,
                                                      @RequestParam String orderId) {
        RedemptionService.Eligibility e = redemption.redeem(id, userId, orderAmount, orderId);
        return ResponseEntity.status(e.httpStatus).body(Map.of("result", e.name()));
    }

    @GetMapping("/coupons/{id}/stats")
    public Map<String, Object> stats(@PathVariable long id) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("totalStock", jdbc.queryForObject("SELECT total_stock FROM coupon WHERE id = ?", Integer.class, id));
        m.put("dbStock", jdbc.queryForObject("SELECT stock FROM coupon WHERE id = ?", Integer.class, id));
        m.put("dbClaims", jdbc.queryForObject("SELECT COUNT(*) FROM coupon_claim WHERE coupon_id = ?", Long.class, id));
        m.put("dbRedeemed", jdbc.queryForObject(
                "SELECT COUNT(*) FROM coupon_claim WHERE coupon_id = ? AND status = 'REDEEMED'", Long.class, id));
        String rs = redis.opsForValue().get(RedisClaimService.stockKey(id));
        m.put("redisStock", rs == null ? null : Long.parseLong(rs));
        m.put("redisClaimed", redis.opsForSet().size(RedisClaimService.usersKey(id)));
        return m;
    }

    @GetMapping("/metrics/sql")
    public Map<String, Long> sqlCount() {
        return Map.of("syncSqlCount", db.count());
    }

    @PostMapping("/metrics/sql/reset")
    public Map<String, Long> resetSql() {
        db.reset();
        return Map.of("syncSqlCount", 0L);
    }

    /** Consumer counters since this app instance started (they reset on restart). */
    @GetMapping("/metrics/consumer")
    public Map<String, Object> consumerStats() {
        return consumer.stats();
    }
}
