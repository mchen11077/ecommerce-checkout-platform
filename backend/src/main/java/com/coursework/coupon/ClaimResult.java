package com.coursework.coupon;

public enum ClaimResult {
    OK(200), SOLD_OUT(409), ALREADY_CLAIMED(409), NOT_FOUND(404),
    NOT_ISSUED(409), NOT_STARTED(409), EXPIRED(409), RATE_LIMITED(429), LOCK_TIMEOUT(503);

    public final int httpStatus;

    ClaimResult(int httpStatus) {
        this.httpStatus = httpStatus;
    }
}
