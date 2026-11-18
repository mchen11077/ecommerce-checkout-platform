package com.coursework.coupon;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpStatus;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.client.oidc.web.logout.OidcClientInitiatedLogoutSuccessHandler;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.registration.InMemoryClientRegistrationRepository;
import org.springframework.security.oauth2.core.AuthorizationGrantType;
import org.springframework.security.oauth2.core.ClientAuthenticationMethod;
import org.springframework.security.oauth2.core.oidc.user.OidcUserAuthority;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.HttpStatusEntryPoint;
import org.springframework.security.web.savedrequest.NullRequestCache;
import org.springframework.security.web.util.matcher.AntPathRequestMatcher;

@Configuration
@Profile("production & browser-login")
class BrowserLogin {
    private static final Set<String> ROLES = Set.of("coupon.customer", "coupon.admin", "coupon.metrics");

    @Bean
    ClientRegistrationRepository browserClients(
            @Value("${coupon.login.issuer}") String issuer,
            @Value("${coupon.login.backchannel}") String backchannel,
            @Value("${coupon.login.origin}") String origin,
            @Value("${coupon.login.client-id}") String clientId,
            @Value("${coupon.login.client-secret}") String clientSecret) {
        var client = ClientRegistration.withRegistrationId("coupon")
                .clientId(clientId).clientSecret(clientSecret)
                .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                .redirectUri(origin + "/login/oauth2/code/coupon")
                .scope("openid", "profile")
                .issuerUri(issuer)
                .authorizationUri(issuer + "/protocol/openid-connect/auth")
                .tokenUri(backchannel + "/protocol/openid-connect/token")
                .jwkSetUri(backchannel + "/protocol/openid-connect/certs")
                .providerConfigurationMetadata(Map.of("end_session_endpoint", issuer + "/protocol/openid-connect/logout"))
                .clientName("Coupon shop")
                .build();
        return new InMemoryClientRegistrationRepository(client);
    }

    @Bean
    SecurityFilterChain browserSecurity(HttpSecurity http, ClientRegistrationRepository clients,
                                        @Value("${coupon.login.origin}") String origin) throws Exception {
        var logout = new OidcClientInitiatedLogoutSuccessHandler(clients);
        logout.setPostLogoutRedirectUri(origin + "/");
        http.oauth2Login(login -> login.defaultSuccessUrl(origin + "/", true)
                        .userInfoEndpoint(info -> info.userAuthoritiesMapper(authorities -> {
                            Set<GrantedAuthority> mapped = new HashSet<>(authorities);
                            for (GrantedAuthority authority : authorities) {
                                if (authority instanceof OidcUserAuthority oidc
                                        && oidc.getIdToken().getClaims().get("coupon_roles") instanceof List<?> roles) {
                                    roles.stream().filter(ROLES::contains)
                                            .forEach(role -> mapped.add(new SimpleGrantedAuthority("SCOPE_" + role)));
                                }
                            }
                            return mapped;
                        })))
                .requestCache(cache -> cache.requestCache(new NullRequestCache()))
                .logout(config -> config.logoutSuccessHandler(logout))
                .exceptionHandling(errors -> errors.defaultAuthenticationEntryPointFor(
                        new HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED), new AntPathRequestMatcher("/api/**")));
        return CouponSecurity.routes(http, "/oauth2/authorization/coupon", "/login/oauth2/code/coupon",
                "/api/session").build();
    }
}
