package com.coursework.coupon;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.Map;
import java.security.Principal;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.security.oauth2.client.authentication.OAuth2AuthenticationToken;
import org.springframework.security.oauth2.core.oidc.user.OidcUser;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.HandlerMapping;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
@Profile("production")
class CheckoutOwnership implements WebMvcConfigurer, HandlerInterceptor {
    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(this).addPathPatterns("/api/users/{userId}/coupons",
                "/api/checkout/users/{userId}/orders", "/api/checkout/users/{userId}/orders/{orderId}",
                "/api/checkout/users/{userId}/orders/{orderId}/refund", "/api/checkout/users/{userId}/orders/{orderId}/ship",
                "/api/coupons/{id}/claim", "/api/checkout/quote");
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler)
            throws java.io.IOException {
        Object pathVariables = request.getAttribute(HandlerMapping.URI_TEMPLATE_VARIABLES_ATTRIBUTE);
        String[] parameters = request.getParameterValues("userId");
        Object pathUser = pathVariables instanceof Map<?, ?> variables ? variables.get("userId") : null;
        String requestedUser = pathUser instanceof String id ? id
                : parameters != null && parameters.length == 1 ? parameters[0] : null;
        if (isOwner(customerId(request.getUserPrincipal()), requestedUser)) {
            return true;
        }
        response.setStatus(HttpServletResponse.SC_FORBIDDEN);
        response.setContentType("application/json");
        response.getWriter().write("{\"result\":\"FORBIDDEN\"}");
        return false;
    }

    static Object customerId(Principal principal) {
        if (principal instanceof JwtAuthenticationToken bearer) {
            return bearer.getToken().getClaims().get("coupon_user_id");
        }
        if (principal instanceof OAuth2AuthenticationToken login && login.getPrincipal() instanceof OidcUser user) {
            return user.getIdToken().getClaims().get("coupon_user_id");
        }
        return null;
    }

    private static boolean isOwner(Object claim, String requestedUser) {
        if (!(claim instanceof String id) || requestedUser == null) return false;
        try {
            long userId = Long.parseLong(id);
            return userId > 0 && userId == Long.parseLong(requestedUser);
        } catch (NumberFormatException invalidId) {
            return false;
        }
    }
}
