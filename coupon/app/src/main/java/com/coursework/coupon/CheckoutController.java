package com.coursework.coupon;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/checkout")
public class CheckoutController {
    private static final long GUEST_ORDER_OWNER = 0;
    public record Product(String id, String name, int cents, String category, String description) {}
    public record Pricing(String result, int subtotalCents, int discountCents, int totalCents, long shortfallCents,
                          @JsonInclude(JsonInclude.Include.NON_NULL) String giftName) {}
    public record Item(String productId, int quantity) {}
    public record OrderRequest(String productId, Long couponId, List<Item> items) {}
    public record Receipt(UUID orderId, String productId, Long couponId, Pricing pricing,
                          @JsonInclude(JsonInclude.Include.NON_NULL) List<Item> items) {}
    public record OrderLine(String name, int quantity) {}
    public record OrderSummary(UUID orderId, OffsetDateTime createdAt, List<OrderLine> items, Pricing pricing,
                               String paymentStatus, String shippingStatus) {}
    public record Stock(String productId, int available) {}

    private static final List<Product> PRODUCTS = List.of(
            new Product("silicone-utensils", "Silicone utensil set", 2500, "Kitchen tools",
                    "Three heat-resistant utensils with soft edges for nonstick cookware."),
            new Product("nonstick-skillet", "Nonstick skillet", 5000, "Cookware",
                    "A 10-inch skillet with a stay-cool handle for everyday cooking."),
            new Product("stainless-stockpot", "Stainless steel stockpot", 7500, "Cookware",
                    "A 6-quart stainless steel pot with a lid for soups, stock and batch cooking."),
            new Product("glass-storage", "Glass storage set", 3500, "Food storage",
                    "Three stackable glass containers with snap-lock lids."));
    private static final Map<String, Product> LEGACY_PRODUCTS = Map.of(
            "canvas-tote", new Product("canvas-tote", "Canvas tote", 5000, null, null),
            "weekender-bag", new Product("weekender-bag", "Weekender bag", 12000, null, null));

    private final JdbcTemplate jdbc;
    private final RedemptionService redemption;
    private final TransactionTemplate tx;

    public CheckoutController(JdbcTemplate jdbc, RedemptionService redemption, TransactionTemplate tx) {
        this.jdbc = jdbc;
        this.redemption = redemption;
        this.tx = tx;
    }

    @GetMapping("/products")
    public List<Product> products() {
        return PRODUCTS;
    }

    @GetMapping("/stock")
    public List<Stock> stock() {
        return jdbc.query("SELECT product_id, available FROM product_inventory",
                (row, index) -> new Stock(row.getString("product_id"), row.getInt("available")));
    }

    @GetMapping("/users/{userId}/orders")
    public List<OrderSummary> orders(@PathVariable long userId,
                                     @RequestParam(defaultValue = "0") int offset) {
        if (userId <= 0) throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        if (offset < 0) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid order offset");
        return jdbc.query("""
                SELECT order_id, created_at, product_id, coupon_id, subtotal_cents, discount_cents, gift_name, cart_items,
                       payment_status, shipping_status
                FROM checkout_order WHERE user_id = ?
                ORDER BY created_at DESC, order_id DESC
                LIMIT 20 OFFSET ?
                """, (row, index) -> {
            var receipt = readReceipt(row, row.getObject("order_id", UUID.class));
            var items = receiptItems(receipt).stream()
                    .map(item -> new OrderLine(product(item.productId()).name(), item.quantity()))
                    .toList();
            return new OrderSummary(receipt.orderId(), row.getObject("created_at", OffsetDateTime.class),
                    items, receipt.pricing(), row.getString("payment_status"), row.getString("shipping_status"));
        }, userId, offset);
    }

    @GetMapping("/quote")
    public Pricing quoteRequest(@RequestParam long userId, @RequestParam(required = false) String productId,
                                @RequestParam long couponId, @RequestParam(required = false) String cart) {
        var items = normalizeItems(productId, cart == null ? null : decodeItems(cart));
        return price(userId, subtotal(items), couponId);
    }

    @PostMapping("/users/{userId}/orders/{orderId}")
    public ResponseEntity<?> confirm(@PathVariable long userId, @PathVariable UUID orderId,
                                     @RequestBody OrderRequest request) {
        if (userId <= 0) return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("result", "FORBIDDEN"));
        return confirmOrder(userId, orderId, request);
    }

    @PostMapping("/guest/orders/{orderId}")
    public ResponseEntity<?> confirmGuest(@PathVariable UUID orderId, @RequestBody OrderRequest request) {
        if (request.couponId() != null) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("result", "SIGN_IN_FOR_COUPONS"));
        }
        return confirmOrder(GUEST_ORDER_OWNER, orderId, request);
    }

    private ResponseEntity<?> confirmOrder(long userId, UUID orderId, OrderRequest request) {
        List<Item> items = normalizeItems(request.productId(), request.items());
        int subtotal = subtotal(items);
        String cart = request.items() == null ? null : encodeItems(items);
        return tx.execute(status -> {
            Receipt existing = receipt(userId, orderId);
            if (existing != null) return replay(existing, items, request.couponId());

            Pricing pricing = request.couponId() == null
                    ? new Pricing("ELIGIBLE", subtotal, 0, subtotal, 0, null)
                    : price(userId, subtotal, request.couponId());
            if (!"ELIGIBLE".equals(pricing.result())) {
                // A concurrent request may have committed between the receipt read and eligibility check.
                existing = receipt(userId, orderId);
                if (existing != null) return replay(existing, items, request.couponId());
                return rejection(RedemptionService.Eligibility.valueOf(pricing.result()));
            }

            int inserted = jdbc.update("""
                    INSERT INTO checkout_order (user_id, order_id, product_id, coupon_id, subtotal_cents, discount_cents, gift_name, cart_items, payment_status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PAID')
                    ON CONFLICT (user_id, order_id) DO NOTHING
                    """, userId, orderId, request.productId(), request.couponId(), pricing.subtotalCents(), pricing.discountCents(),
                    pricing.giftName(), cart);
            if (inserted == 0) return replay(receipt(userId, orderId), items, request.couponId());
            for (Item item : items) {
                int reserved = jdbc.update("""
                        UPDATE product_inventory SET available = available - ?
                        WHERE product_id = ? AND available >= ?
                        """, item.quantity(), item.productId(), item.quantity());
                if (reserved == 0) {
                    status.setRollbackOnly();
                    return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("result", "INSUFFICIENT_STOCK"));
                }
            }
            if (request.couponId() == null) return ResponseEntity.ok(receipt(userId, orderId));

            RedemptionService.Eligibility result = redemption.redeem(
                    request.couponId(), userId, BigDecimal.valueOf(subtotal, 2), "demo-" + orderId);
            if (result != RedemptionService.Eligibility.REDEEMED) {
                status.setRollbackOnly();
                return rejection(result);
            }
            return ResponseEntity.ok(receipt(userId, orderId));
        });
    }

    @PostMapping("/users/{userId}/orders/{orderId}/refund")
    public ResponseEntity<?> refund(@PathVariable long userId, @PathVariable UUID orderId) {
        return changeOrder(userId, orderId, true);
    }

    @PostMapping("/users/{userId}/orders/{orderId}/ship")
    public ResponseEntity<?> ship(@PathVariable long userId, @PathVariable UUID orderId) {
        return changeOrder(userId, orderId, false);
    }

    private ResponseEntity<?> changeOrder(long userId, UUID orderId, boolean refund) {
        if (userId <= 0) return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("result", "FORBIDDEN"));
        return tx.execute(transaction -> {
            var states = jdbc.query("""
                    SELECT payment_status, shipping_status FROM checkout_order
                    WHERE user_id = ? AND order_id = ? FOR UPDATE
                    """, (row, index) -> Map.of("payment", row.getString(1), "shipping", row.getString(2)),
                    userId, orderId);
            if (states.isEmpty()) return ResponseEntity.notFound().build();
            var state = states.getFirst();
            String result = refund ? "REFUNDED" : "SHIPPED";
            if (state.containsValue(result)) return ResponseEntity.ok(Map.of("result", result));
            if (!"PAID".equals(state.get("payment")) || !"UNSHIPPED".equals(state.get("shipping"))) {
                return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("result", "ORDER_ACTION_UNAVAILABLE"));
            }
            if (refund) {
                jdbc.update("UPDATE checkout_order SET payment_status = 'REFUNDED' WHERE user_id = ? AND order_id = ?", userId, orderId);
                for (Item item : receiptItems(receipt(userId, orderId))) {
                    jdbc.update("UPDATE product_inventory SET available = available + ? WHERE product_id = ?",
                            item.quantity(), item.productId());
                }
            } else {
                jdbc.update("UPDATE checkout_order SET shipping_status = 'SHIPPED' WHERE user_id = ? AND order_id = ?", userId, orderId);
            }
            return ResponseEntity.ok(Map.of("result", result));
        });
    }

    private Pricing price(long userId, int subtotal, long couponId) {
        var result = redemption.check(couponId, userId, BigDecimal.valueOf(subtotal, 2));
        int discount = 0;
        long shortfall = 0;
        String giftName = null;
        if (result == RedemptionService.Eligibility.ELIGIBLE || result == RedemptionService.Eligibility.BELOW_MIN_ORDER) {
            Map<String, Object> terms = jdbc.queryForMap(
                    "SELECT min_order_amount, discount_amount, gift_name FROM coupon WHERE id = ?", couponId);
            if (result == RedemptionService.Eligibility.ELIGIBLE) {
                long cents = ((BigDecimal) terms.get("discount_amount")).movePointRight(2).longValueExact();
                discount = (int) Math.min(cents, subtotal);
                giftName = (String) terms.get("gift_name");
            } else {
                long minimum = ((BigDecimal) terms.get("min_order_amount")).movePointRight(2).longValueExact();
                shortfall = Math.max(0, minimum - subtotal);
            }
        }
        return new Pricing(result.name(), subtotal, discount, subtotal - discount, shortfall, giftName);
    }

    private Receipt receipt(long userId, UUID orderId) {
        return jdbc.query("""
                SELECT product_id, coupon_id, subtotal_cents, discount_cents, gift_name, cart_items
                FROM checkout_order WHERE user_id = ? AND order_id = ?
                """, (row, index) -> readReceipt(row, orderId), userId, orderId).stream().findFirst().orElse(null);
    }

    private static Receipt readReceipt(ResultSet row, UUID orderId) throws SQLException {
        int subtotal = row.getInt("subtotal_cents");
        int discount = row.getInt("discount_cents");
        Long couponId = row.getObject("coupon_id", Long.class);
        String cart = row.getString("cart_items");
        return new Receipt(orderId, row.getString("product_id"), couponId,
                new Pricing(couponId == null ? "CONFIRMED" : "REDEEMED",
                        subtotal, discount, subtotal - discount, 0, row.getString("gift_name")),
                cart == null ? null : decodeItems(cart));
    }

    private static List<Item> receiptItems(Receipt receipt) {
        return receipt.items() == null ? List.of(new Item(receipt.productId(), 1)) : receipt.items();
    }

    private static Product product(String id) {
        Product legacy = LEGACY_PRODUCTS.get(id);
        if (legacy != null) return legacy;
        return PRODUCTS.stream().filter(product -> product.id().equals(id)).findFirst()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unknown product"));
    }

    private static List<Item> normalizeItems(String productId, List<Item> items) {
        if (items == null && productId != null) items = List.of(new Item(productId, 1));
        else if (productId != null || items == null) throw invalidCart();
        if (items.isEmpty() || items.size() > PRODUCTS.size() + LEGACY_PRODUCTS.size()) throw invalidCart();
        var seen = new HashSet<String>();
        for (Item item : items) {
            if (item == null || item.productId() == null || item.quantity() < 1
                    || item.quantity() > 99 || !seen.add(item.productId())) {
                throw invalidCart();
            }
        }
        return items.stream().sorted(Comparator.comparing(Item::productId)).toList();
    }

    private static int subtotal(List<Item> items) {
        return items.stream().mapToInt(item -> product(item.productId()).cents() * item.quantity()).sum();
    }

    private static String encodeItems(List<Item> items) {
        return String.join(",", items.stream().map(item -> item.productId() + ":" + item.quantity()).toList());
    }

    private static List<Item> decodeItems(String cart) {
        try {
            return Arrays.stream(cart.split(",", -1)).map(line -> {
                var fields = line.split(":", -1);
                if (fields.length != 2) throw invalidCart();
                return new Item(fields[0], Integer.parseInt(fields[1]));
            }).toList();
        } catch (NumberFormatException invalidQuantity) {
            throw invalidCart();
        }
    }

    private static ResponseStatusException invalidCart() {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, "Select valid cart items and quantities from 1 to 99");
    }

    private static ResponseEntity<?> replay(Receipt existing, List<Item> items, Long couponId) {
        if (!receiptItems(existing).equals(items) || !Objects.equals(existing.couponId(), couponId)) {
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("result", "ORDER_CONFLICT"));
        }
        return ResponseEntity.ok(existing);
    }

    private static ResponseEntity<Map<String, String>> rejection(RedemptionService.Eligibility result) {
        return ResponseEntity.status(result.httpStatus).body(Map.of("result", result.name()));
    }
}
