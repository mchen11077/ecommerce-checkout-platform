package com.coursework.coupon;

import jakarta.servlet.DispatcherType;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
class CouponSecurity {
    @Bean
    @Profile("!production")
    SecurityFilterChain demoSecurity(HttpSecurity http) throws Exception {
        return http.csrf(AbstractHttpConfigurer::disable)
                .authorizeHttpRequests(auth -> auth.anyRequest().permitAll())
                .build();
    }

    @Bean
    @Profile("production & !browser-login")
    SecurityFilterChain productionSecurity(HttpSecurity http) throws Exception {
        http.csrf(AbstractHttpConfigurer::disable)
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .oauth2ResourceServer(server -> server.jwt(Customizer.withDefaults()));
        return routes(http).build();
    }

    static HttpSecurity routes(HttpSecurity http, String... publicBrowserPaths) throws Exception {
        return http.authorizeHttpRequests(auth -> {
            if (publicBrowserPaths.length > 0) auth.requestMatchers(HttpMethod.GET, publicBrowserPaths).permitAll();
            auth
                        .dispatcherTypeMatchers(DispatcherType.ERROR).permitAll()
                        .requestMatchers(HttpMethod.GET, "/actuator/health", "/actuator/health/liveness",
                                "/actuator/health/readiness", "/api/coupons", "/api/checkout/products",
                                "/api/checkout/stock").permitAll()
                        .requestMatchers(HttpMethod.POST, "/api/checkout/guest/orders/*").permitAll()
                        .requestMatchers(HttpMethod.GET, "/actuator/prometheus").hasAuthority("SCOPE_coupon.metrics")
                        .requestMatchers(HttpMethod.POST, "/api/coupons", "/api/coupons/*/issue")
                                .hasAuthority("SCOPE_coupon.admin")
                        .requestMatchers(HttpMethod.GET, "/api/users/*/coupons", "/api/checkout/quote",
                                "/api/checkout/users/*/orders")
                                .hasAuthority("SCOPE_coupon.customer")
                        .requestMatchers(HttpMethod.POST, "/api/coupons/*/claim", "/api/checkout/users/*/orders/*")
                                .hasAuthority("SCOPE_coupon.customer")
                        .requestMatchers(HttpMethod.POST, "/api/checkout/users/*/orders/*/refund", "/api/checkout/users/*/orders/*/ship")
                                .hasAuthority("SCOPE_coupon.customer")
                        .anyRequest().denyAll();
        });
    }
}
