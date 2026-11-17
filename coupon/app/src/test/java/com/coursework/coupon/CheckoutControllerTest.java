package com.coursework.coupon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.startsWith;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

class CheckoutControllerTest {
    private static final long USER_ID = 101;
    private static final long COUPON_ID = 8;
    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final RedemptionService redemption = mock(RedemptionService.class);
    private final CheckoutController checkout =
            new CheckoutController(jdbc, redemption, mock(TransactionTemplate.class));

    @ParameterizedTest
    @CsvSource({
        "20.00, 2000, 10000",
        "20.01, 2001, 9999",
        "0.00, 0, 12000",
        "150.00, 12000, 0"
    })
    void eligibleQuoteUsesServerPriceAndCapsDiscount(String discount, int expectedDiscount, int expectedTotal) {
        when(redemption.check(COUPON_ID, USER_ID, new BigDecimal("120.00")))
                .thenReturn(RedemptionService.Eligibility.ELIGIBLE);
        couponTerms("100.00", discount);

        var quote = checkout.quoteRequest(USER_ID, "weekender-bag", COUPON_ID, null);

        assertEquals(new CheckoutController.Pricing(
                "ELIGIBLE", 12000, expectedDiscount, expectedTotal, 0, null), quote);
    }

    @Test
    void belowMinimumQuoteReturnsExactShortfallAndNoDiscount() {
        when(redemption.check(COUPON_ID, USER_ID, new BigDecimal("50.00")))
                .thenReturn(RedemptionService.Eligibility.BELOW_MIN_ORDER);
        couponTerms("100.01", "20.00");

        var quote = checkout.quoteRequest(USER_ID, "canvas-tote", COUPON_ID, null);

        assertEquals(new CheckoutController.Pricing("BELOW_MIN_ORDER", 5000, 0, 5000, 5001, null), quote);
    }

    @Test
    void expiredCouponKeepsItsRejectionWithoutLoadingDiscountTerms() {
        when(redemption.check(COUPON_ID, USER_ID, new BigDecimal("120.00")))
                .thenReturn(RedemptionService.Eligibility.EXPIRED);

        var quote = checkout.quoteRequest(USER_ID, "weekender-bag", COUPON_ID, null);

        assertEquals(new CheckoutController.Pricing("EXPIRED", 12000, 0, 12000, 0, null), quote);
        verifyNoInteractions(jdbc);
    }

    private void couponTerms(String minimum, String discount) {
        when(jdbc.queryForMap(startsWith("SELECT min_order_amount, discount_amount"), eq(COUPON_ID)))
                .thenReturn(Map.of("min_order_amount", new BigDecimal(minimum),
                        "discount_amount", new BigDecimal(discount)));
    }
}
