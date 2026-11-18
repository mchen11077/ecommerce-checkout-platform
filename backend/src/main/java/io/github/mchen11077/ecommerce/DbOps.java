package io.github.mchen11077.ecommerce;

import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** JDBC wrapper used ONLY on the synchronous claim path, so we can count SQL per request. */
@Component
public class DbOps {
    private final JdbcTemplate jdbc;
    private final AtomicLong syncSqlCount = new AtomicLong();

    public DbOps(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Integer queryInt(String sql, Object... args) {
        syncSqlCount.incrementAndGet();
        List<Integer> rows = jdbc.queryForList(sql, Integer.class, args);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public int update(String sql, Object... args) {
        syncSqlCount.incrementAndGet();
        return jdbc.update(sql, args);
    }

    public long count() {
        return syncSqlCount.get();
    }

    public void reset() {
        syncSqlCount.set(0);
    }
}
