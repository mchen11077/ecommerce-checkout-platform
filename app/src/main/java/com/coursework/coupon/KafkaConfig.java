package com.coursework.coupon;

import org.apache.kafka.clients.admin.NewTopic;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.kafka.config.TopicBuilder;

@Configuration
@Profile("!production")
public class KafkaConfig {
    private final int partitions;

    public KafkaConfig(@Value("${coupon.kafka.partitions:12}") int partitions) {
        this.partitions = partitions;
    }

    /**
     * 12 partitions: with key = userId, a single hot coupon is spread over all of them instead of
     * funnelling every event of that coupon into one partition (which leaves the other consumer
     * threads of the group idle).
     */
    @Bean
    public NewTopic couponClaimedTopic() {
        return TopicBuilder.name(RedisClaimService.TOPIC).partitions(partitions).replicas(1).build();
    }
}
