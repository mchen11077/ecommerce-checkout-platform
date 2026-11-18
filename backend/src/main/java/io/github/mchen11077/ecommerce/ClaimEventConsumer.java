package io.github.mchen11077.ecommerce;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Step 4.2: persists claims from Kafka into PostgreSQL. Idempotent: the unique (coupon_id, user_id)
 * constraint plus ON CONFLICT DO NOTHING means a redelivered event inserts nothing, and DB stock is only
 * decremented for rows that were really inserted.
 *
 * Step 4.4: two persistence modes, switched with coupon.consumer.batch (env COUPON_CONSUMER_BATCH):
 *   false (default) - one transaction and one INSERT per message (the original version)
 *   true            - one transaction per poll: one multi-row INSERT ... RETURNING, then one UPDATE per coupon
 * Both modes receive the same polled batch, so the only difference is how it is written.
 */
@Component
public class ClaimEventConsumer {
    private static final int ROWS_PER_INSERT = 1000;

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final TransactionTemplate tx;

    @Value("${coupon.consumer.batch:false}")
    private boolean batchMode;

    private final AtomicLong messages = new AtomicLong();
    private final AtomicLong inserted = new AtomicLong();
    private final AtomicLong duplicatesSkipped = new AtomicLong();
    private final AtomicLong polls = new AtomicLong();

    public ClaimEventConsumer(JdbcTemplate jdbc, ObjectMapper mapper, TransactionTemplate tx) {
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.tx = tx;
    }

    @KafkaListener(topics = RedisClaimService.TOPIC,
            concurrency = "${coupon.consumer.concurrency:6}", batch = "true")
    public void onClaims(List<String> payloads) throws Exception {
        polls.incrementAndGet();
        messages.addAndGet(payloads.size());
        List<long[]> events = new ArrayList<>(payloads.size());
        for (String p : payloads) {
            JsonNode node = mapper.readTree(p);
            events.add(new long[] {node.get("couponId").asLong(), node.get("userId").asLong()});
        }
        if (batchMode) {
            persistBatch(events);
        } else {
            for (long[] e : events) {
                persistOne(e[0], e[1]);
            }
        }
    }

    private void persistOne(long couponId, long userId) {
        tx.executeWithoutResult(status -> {
            int n = jdbc.update(
                    "INSERT INTO coupon_claim (coupon_id, user_id, source) VALUES (?, ?, 'redis') "
                            + "ON CONFLICT (coupon_id, user_id) DO NOTHING", couponId, userId);
            if (n == 1) {
                jdbc.update("UPDATE coupon SET stock = stock - 1 WHERE id = ?", couponId);
                inserted.incrementAndGet();
            } else {
                duplicatesSkipped.incrementAndGet();
            }
        });
    }

    private void persistBatch(List<long[]> events) {
        // De-duplicate inside the batch too (a redelivery can put the same event in one poll twice).
        Set<String> seen = new LinkedHashSet<>();
        List<long[]> unique = new ArrayList<>(events.size());
        for (long[] e : events) {
            if (seen.add(e[0] + ":" + e[1])) {
                unique.add(e);
            }
        }
        int inBatchDuplicates = events.size() - unique.size();

        tx.executeWithoutResult(status -> {
            Map<Long, Integer> insertedPerCoupon = new TreeMap<>(); // sorted -> fixed lock order, no deadlocks
            int insertedHere = 0;
            for (int from = 0; from < unique.size(); from += ROWS_PER_INSERT) {
                List<long[]> chunk = unique.subList(from, Math.min(from + ROWS_PER_INSERT, unique.size()));
                StringBuilder sql = new StringBuilder("INSERT INTO coupon_claim (coupon_id, user_id, source) VALUES ");
                Object[] args = new Object[chunk.size() * 2];
                for (int i = 0; i < chunk.size(); i++) {
                    sql.append(i == 0 ? "" : ",").append("(?, ?, 'redis')");
                    args[2 * i] = chunk.get(i)[0];
                    args[2 * i + 1] = chunk.get(i)[1];
                }
                sql.append(" ON CONFLICT (coupon_id, user_id) DO NOTHING RETURNING coupon_id");
                List<Long> rows = jdbc.queryForList(sql.toString(), Long.class, args);
                for (Long couponId : rows) {
                    insertedPerCoupon.merge(couponId, 1, Integer::sum);
                }
                insertedHere += rows.size();
            }
            for (Map.Entry<Long, Integer> e : insertedPerCoupon.entrySet()) {
                jdbc.update("UPDATE coupon SET stock = stock - ? WHERE id = ?", e.getValue(), e.getKey());
            }
            inserted.addAndGet(insertedHere);
            duplicatesSkipped.addAndGet((unique.size() - insertedHere) + inBatchDuplicates);
        });
    }

    public Map<String, Object> stats() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("mode", batchMode ? "batch" : "per-message");
        m.put("messages", messages.get());
        m.put("inserted", inserted.get());
        m.put("duplicatesSkipped", duplicatesSkipped.get());
        m.put("polls", polls.get());
        return m;
    }
}
