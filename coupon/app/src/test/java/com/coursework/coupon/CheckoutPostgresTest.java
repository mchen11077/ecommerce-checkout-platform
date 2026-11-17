package com.coursework.coupon;

import static org.assertj.core.api.Assertions.assertThat;

import com.coursework.coupon.CheckoutController.Item;
import com.coursework.coupon.CheckoutController.OrderRequest;
import com.coursework.coupon.CheckoutController.Receipt;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.transaction.support.TransactionTemplate;

@EnabledIfEnvironmentVariable(named = "CHECKOUT_TEST_JDBC_URL", matches = ".+")
@Timeout(20)
class CheckoutPostgresTest {
    private static final String SKILLET = "nonstick-skillet";
    private static final String UTENSILS = "silicone-utensils";
    private static final long USER = 101;
    private static final List<Item> CART = List.of(new Item(UTENSILS, 2), new Item(SKILLET, 1));

    private final String schema = "checkout_test_" + UUID.randomUUID().toString().replace("-", "");
    private JdbcTemplate database;
    private JdbcTemplate jdbc;
    private TransactionTemplate transactions;
    private CheckoutController checkout;

    @BeforeEach
    void createIsolatedSchema() {
        database = new JdbcTemplate(dataSource());
        database.execute("CREATE SCHEMA " + schema);
        var isolated = dataSource();
        isolated.setSchema(schema);
        new ResourceDatabasePopulator(new ClassPathResource("schema.sql")).execute(isolated);
        jdbc = new JdbcTemplate(isolated);
        transactions = new TransactionTemplate(new DataSourceTransactionManager(isolated));
        checkout = new CheckoutController(jdbc, new RedemptionService(jdbc, transactions), transactions);
    }

    @AfterEach
    void dropIsolatedSchema() {
        if (database != null) database.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    }

    @Test
    void rollsBackEarlierStockAndOrderWhenLaterSkuIsShortAndRetriesSameOrder() {
        long coupon = jdbc.queryForObject("""
                INSERT INTO coupon (name, total_stock, stock, status, min_order_amount, discount_amount)
                VALUES ('Test discount', 1, 1, 'ACTIVE', 100, 20) RETURNING id
                """, Long.class);
        jdbc.update("INSERT INTO coupon_claim (coupon_id, user_id, source) VALUES (?, ?, 'TEST')", coupon, USER);
        jdbc.update("UPDATE product_inventory SET available = 1 WHERE product_id = ?", UTENSILS);
        int skilletBefore = stock(SKILLET);
        var id = UUID.randomUUID();
        var request = new OrderRequest(null, coupon, CART);

        // Checkout normalizes into product ID order, so skillet is reserved before utensils fail.
        assertResponse(checkout.confirm(USER, id, request), HttpStatus.CONFLICT, "INSUFFICIENT_STOCK");
        assertThat(stock(SKILLET)).isEqualTo(skilletBefore);
        assertThat(stock(UTENSILS)).isEqualTo(1);
        assertThat(checkout.orders(USER, 0)).isEmpty();
        assertThat(redemptionCount()).isZero();
        assertThat(jdbc.queryForObject("SELECT use_count FROM coupon_claim", Integer.class)).isZero();

        jdbc.update("UPDATE product_inventory SET available = 2 WHERE product_id = ?", UTENSILS);
        var retry = checkout.confirm(USER, id, request);
        assertThat(retry.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(retry.getBody()).isInstanceOfSatisfying(Receipt.class, receipt -> {
            assertThat(receipt.orderId()).isEqualTo(id);
            assertThat(receipt.pricing().totalCents()).isEqualTo(8_000);
        });
        assertThat(checkout.confirm(USER, id, request)).isEqualTo(retry);
        assertThat(checkout.orders(USER, 0)).hasSize(1);
        assertThat(stock(SKILLET)).isEqualTo(skilletBefore - 1);
        assertThat(stock(UTENSILS)).isZero();
        assertThat(redemptionCount()).isEqualTo(1);
    }

    @ParameterizedTest(name = "{0} wins and repeated actions preserve stock")
    @CsvSource({"REFUNDED, REFUNDED, UNSHIPPED, 0", "SHIPPED, PAID, SHIPPED, 1"})
    void serializesRefundAndShipment(String winner, String payment, String shipment, int stockDeducted)
            throws Exception {
        int skilletBefore = stock(SKILLET);
        int utensilsBefore = stock(UTENSILS);
        var id = UUID.randomUUID();
        assertThat(checkout.confirm(USER, id, new OrderRequest(null, null, CART)).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(stock(SKILLET)).isEqualTo(skilletBefore - 1);
        assertThat(stock(UTENSILS)).isEqualTo(utensilsBefore - 2);

        String loser = winner.equals("REFUNDED") ? "SHIPPED" : "REFUNDED";
        try (var executor = Executors.newSingleThreadExecutor()) {
            var competitor = transactions.execute(status -> {
                int ownerPid = jdbc.queryForObject("SELECT pg_backend_pid()", Integer.class);
                assertResponse(action(id, winner), HttpStatus.OK, winner);
                // Keep the first transition uncommitted until PostgreSQL confirms the second is waiting.
                var pending = executor.submit(() -> action(id, loser));
                awaitBlockedBy(ownerPid);
                return pending;
            });
            assertResponse(competitor.get(5, TimeUnit.SECONDS), HttpStatus.CONFLICT, "ORDER_ACTION_UNAVAILABLE");
        }

        assertResponse(action(id, winner), HttpStatus.OK, winner);
        assertResponse(action(id, loser), HttpStatus.CONFLICT, "ORDER_ACTION_UNAVAILABLE");
        assertThat(checkout.orders(USER, 0)).singleElement().satisfies(order -> {
            assertThat(order.orderId()).isEqualTo(id);
            assertThat(order.paymentStatus()).isEqualTo(payment);
            assertThat(order.shippingStatus()).isEqualTo(shipment);
        });
        assertThat(stock(SKILLET)).isEqualTo(skilletBefore - stockDeducted);
        assertThat(stock(UTENSILS)).isEqualTo(utensilsBefore - 2 * stockDeducted);
    }

    private void awaitBlockedBy(int ownerPid) {
        Instant deadline = Instant.now().plus(Duration.ofSeconds(5));
        do {
            if (Boolean.TRUE.equals(database.queryForObject("""
                    SELECT EXISTS (
                        SELECT 1 FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid))
                    )
                    """, Boolean.class, ownerPid))) return;
            try {
                Thread.sleep(25);
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                throw new AssertionError("Interrupted while waiting for the competing transaction", exception);
            }
        } while (Instant.now().isBefore(deadline));
        throw new AssertionError("PostgreSQL did not report the competing transaction waiting for the order lock");
    }

    private ResponseEntity<?> action(UUID id, String result) {
        return result.equals("REFUNDED") ? checkout.refund(USER, id) : checkout.ship(USER, id);
    }

    private int stock(String product) {
        return jdbc.queryForObject("SELECT available FROM product_inventory WHERE product_id = ?", Integer.class, product);
    }

    private int redemptionCount() {
        return jdbc.queryForObject("SELECT count(*) FROM coupon_redemption", Integer.class);
    }

    private static void assertResponse(ResponseEntity<?> response, HttpStatus status, String result) {
        assertThat(response.getStatusCode()).isEqualTo(status);
        assertThat(response.getBody()).isEqualTo(Map.of("result", result));
    }

    private static DriverManagerDataSource dataSource() {
        return new DriverManagerDataSource(System.getenv("CHECKOUT_TEST_JDBC_URL"),
                System.getenv("CHECKOUT_TEST_DB_USER"), System.getenv("CHECKOUT_TEST_DB_PASSWORD"));
    }
}
