package com.coursework.coupon;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.util.matcher.AntPathRequestMatcher;

@Configuration
@ConditionalOnProperty(name = "coupon.internal-metrics", havingValue = "true")
class InternalMetrics {
    @Bean
    @Order(0)
    SecurityFilterChain metricsSecurity(HttpSecurity http, @Value("${management.server.port}") int port)
            throws Exception {
        var metrics = new AntPathRequestMatcher("/actuator/prometheus", "GET");
        return http.securityMatcher(request -> request.getLocalPort() == port && metrics.matches(request))
                .authorizeHttpRequests(auth -> auth.anyRequest().permitAll())
                .build();
    }
}
