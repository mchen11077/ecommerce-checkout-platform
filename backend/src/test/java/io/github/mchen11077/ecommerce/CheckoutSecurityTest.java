package io.github.mchen11077.ecommerce;

import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.math.BigDecimal;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.support.TransactionTemplate;

@WebMvcTest(controllers = CheckoutController.class, properties = {
        "COUPON_JWT_ISSUER=https://identity.example.invalid/realms/coupons",
        "COUPON_JWT_AUDIENCE=test-client"
})
@ActiveProfiles("production")
@Import({CouponSecurity.class, CheckoutOwnership.class})
class CheckoutSecurityTest {
    @Autowired private MockMvc mvc;
    @MockBean private JwtDecoder jwtDecoder;
    @MockBean private JdbcTemplate jdbc;
    @MockBean private RedemptionService redemption;
    @MockBean private TransactionTemplate transactions;

    @Test
    void publicCatalogDoesNotRequireAToken() throws Exception {
        mvc.perform(get("/api/checkout/products")).andExpect(status().isOk());
    }

    @Test
    void quoteRequiresAuthentication() throws Exception {
        mvc.perform(get("/api/checkout/quote")).andExpect(status().isUnauthorized());
    }

    @Test
    void customerCannotQuoteForAnotherUser() throws Exception {
        mvc.perform(get("/api/checkout/quote").param("userId", "102")
                .with(jwt().jwt(token -> token.claim("coupon_user_id", "101"))
                        .authorities(new SimpleGrantedAuthority("SCOPE_coupon.customer"))))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.result").value("FORBIDDEN"));
    }

    @Test
    void customerCanQuoteForTheirOwnUser() throws Exception {
        when(redemption.check(8, 101, new BigDecimal("50.00")))
                .thenReturn(RedemptionService.Eligibility.NOT_CLAIMED);
        mvc.perform(get("/api/checkout/quote").param("userId", "101")
                .param("productId", "canvas-tote").param("couponId", "8")
                .with(jwt().jwt(token -> token.claim("coupon_user_id", "101"))
                        .authorities(new SimpleGrantedAuthority("SCOPE_coupon.customer"))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.result").value("NOT_CLAIMED"));
    }
}
