package com.coursework.coupon;

import java.security.Principal;
import org.springframework.context.annotation.Profile;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@Profile("production & browser-login")
class BrowserSessionController {
    record Session(String userId, String csrfHeader, String csrfParameter, String csrfToken) {}

    @GetMapping("/api/session")
    ResponseEntity<Session> session(Principal principal, CsrfToken csrf) {
        Object id = CheckoutOwnership.customerId(principal);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(new Session(id instanceof String userId ? userId : null,
                        csrf.getHeaderName(), csrf.getParameterName(), csrf.getToken()));
    }
}
