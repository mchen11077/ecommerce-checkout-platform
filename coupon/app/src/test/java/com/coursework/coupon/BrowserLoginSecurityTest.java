package com.coursework.coupon;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.oidcLogin;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.support.TransactionTemplate;

@WebMvcTest(controllers = {CheckoutController.class, BrowserSessionController.class}, properties = {
        "COUPON_JWT_ISSUER=https://identity.example.invalid/realms/coupons",
        "COUPON_JWT_AUDIENCE=test-client",
        "coupon.login.issuer=https://identity.example.invalid/realms/coupons",
        "coupon.login.backchannel=https://identity.example.invalid/realms/coupons",
        "coupon.login.origin=https://shop.example.invalid",
        "coupon.login.client-id=test-client",
        "coupon.login.client-secret=test-only"
})
@ActiveProfiles({"production", "browser-login"})
@Import({CouponSecurity.class, BrowserLogin.class, CheckoutOwnership.class})
class BrowserLoginSecurityTest {
    @Autowired private MockMvc mvc;
    @MockBean private JdbcTemplate jdbc;
    @MockBean private RedemptionService redemption;
    @MockBean private TransactionTemplate transactions;

    @Test
    void anonymousVisitorCanBrowseButCannotQuote() throws Exception {
        mvc.perform(get("/api/checkout/products")).andExpect(status().isOk());
        mvc.perform(get("/api/checkout/quote")).andExpect(status().isUnauthorized());
    }

    @Test
    void sessionProvidesIdentityAndCsrfToken() throws Exception {
        mvc.perform(get("/api/session")
                        .with(oidcLogin().idToken(token -> token.claim("coupon_user_id", "201"))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.userId").value("201"))
                .andExpect(jsonPath("$.csrfToken").isNotEmpty());
    }

    @Test
    void orderWriteRejectsMissingCsrfAndCrossAccountAccess() throws Exception {
        String url = "/api/checkout/users/202/orders/52efd337-cc27-4b4f-8f39-a73fb8272f51";
        var customer = oidcLogin().idToken(token -> token.claim("coupon_user_id", "201"))
                .authorities(new SimpleGrantedAuthority("SCOPE_coupon.customer"));
        mvc.perform(post(url).with(customer)).andExpect(status().isForbidden());
        mvc.perform(post(url).with(customer).with(csrf()))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.result").value("FORBIDDEN"));
    }
}
