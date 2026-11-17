package com.coursework.coupon;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Unit tests for the eligibility decision. No Spring context, no database: {@code decide} is a pure function,
 * so every rule and every precedence between rules is checked directly.
 */
class RedemptionServiceTest {

    private static final BigDecimal FIFTY = new BigDecimal("50.00");

    private static RedemptionService.Eligibility decide(String couponStatus, boolean notStarted, boolean expired,
            String claimStatus, BigDecimal minOrder, String amount) {
        return RedemptionService.decide(couponStatus, notStarted, expired, claimStatus, minOrder,
                new BigDecimal(amount));
    }

    @Test
    @DisplayName("a coupon that is not ACTIVE cannot be used")
    void notIssuedWhenCouponIsNotActive() {
        var r = decide("DRAFT", false, false, "CLAIMED", FIFTY, "100");
        assertThat(r).isEqualTo(RedemptionService.Eligibility.NOT_ISSUED);
        assertThat(r.httpStatus).isEqualTo(409);
    }

    @Test
    @DisplayName("before valid_from the coupon has not started")
    void notStartedBeforeValidFrom() {
        assertThat(decide("ACTIVE", true, false, "CLAIMED", FIFTY, "100"))
                .isEqualTo(RedemptionService.Eligibility.NOT_STARTED);
    }

    @Test
    @DisplayName("after valid_until the coupon has expired")
    void expiredAfterValidUntil() {
        var r = decide("ACTIVE", false, true, "CLAIMED", FIFTY, "100");
        assertThat(r).isEqualTo(RedemptionService.Eligibility.EXPIRED);
        assertThat(r.httpStatus).isEqualTo(409);
    }

    @Test
    @DisplayName("no claim row means the user never claimed it")
    void notClaimedWhenNoClaimRow() {
        assertThat(decide("ACTIVE", false, false, null, FIFTY, "100"))
                .isEqualTo(RedemptionService.Eligibility.NOT_CLAIMED);
    }

    @Test
    @DisplayName("a redeemed claim cannot be redeemed twice")
    void alreadyRedeemedWhenClaimIsRedeemed() {
        assertThat(decide("ACTIVE", false, false, "REDEEMED", FIFTY, "100"))
                .isEqualTo(RedemptionService.Eligibility.ALREADY_REDEEMED);
    }

    @Test
    @DisplayName("an order 1 cent under the minimum is rejected")
    void belowMinOrderJustUnderThreshold() {
        assertThat(decide("ACTIVE", false, false, "CLAIMED", FIFTY, "49.99"))
                .isEqualTo(RedemptionService.Eligibility.BELOW_MIN_ORDER);
    }

    @Test
    @DisplayName("an order exactly at the minimum is eligible (boundary is inclusive)")
    void eligibleExactlyAtThreshold() {
        assertThat(decide("ACTIVE", false, false, "CLAIMED", FIFTY, "50.00"))
                .isEqualTo(RedemptionService.Eligibility.ELIGIBLE);
    }

    @Test
    @DisplayName("scale does not matter: 50.0 equals 50.00, and comparison is by value")
    void eligibleAtThresholdWithDifferentScale() {
        assertThat(decide("ACTIVE", false, false, "CLAIMED", new BigDecimal("50"), "50.000"))
                .isEqualTo(RedemptionService.Eligibility.ELIGIBLE);
    }

    @Test
    @DisplayName("a coupon without a minimum accepts any amount")
    void eligibleWhenNoMinimumIsSet() {
        assertThat(decide("ACTIVE", false, false, "CLAIMED", null, "0.01"))
                .isEqualTo(RedemptionService.Eligibility.ELIGIBLE);
    }

    @Test
    @DisplayName("expiry outranks 'never claimed' so the user is told the real reason")
    void expiryWinsOverNotClaimed() {
        assertThat(decide("ACTIVE", false, true, null, FIFTY, "100"))
                .isEqualTo(RedemptionService.Eligibility.EXPIRED);
    }

    @Test
    @DisplayName("'not started' outranks 'expired' (a coupon cannot be both, but the order is fixed)")
    void notStartedWinsOverExpired() {
        assertThat(decide("ACTIVE", true, true, "CLAIMED", FIFTY, "100"))
                .isEqualTo(RedemptionService.Eligibility.NOT_STARTED);
    }

    @Test
    @DisplayName("an already redeemed claim outranks the order amount")
    void alreadyRedeemedWinsOverAmount() {
        assertThat(decide("ACTIVE", false, false, "REDEEMED", FIFTY, "0.01"))
                .isEqualTo(RedemptionService.Eligibility.ALREADY_REDEEMED);
    }

    @Test
    @DisplayName("inactive status outranks every other signal")
    void notIssuedWinsOverEverything() {
        assertThat(decide("EXPIRED_COUPON", true, true, "REDEEMED", FIFTY, "0.01"))
                .isEqualTo(RedemptionService.Eligibility.NOT_ISSUED);
    }

    @Test
    @DisplayName("a negative order amount is below any positive minimum")
    void belowMinOrderForNegativeAmount() {
        assertThat(decide("ACTIVE", false, false, "CLAIMED", FIFTY, "-1"))
                .isEqualTo(RedemptionService.Eligibility.BELOW_MIN_ORDER);
    }

    @Test
    @DisplayName("zero minimum and zero amount is eligible, not rejected")
    void eligibleWhenBothAreZero() {
        assertThat(decide("ACTIVE", false, false, "CLAIMED", new BigDecimal("0.00"), "0"))
                .isEqualTo(RedemptionService.Eligibility.ELIGIBLE);
    }
}
