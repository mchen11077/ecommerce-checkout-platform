# Coupon claim experiments

These notes capture the original local Docker experiments. The recorded figures describe that setup. Use the commands from the repository root to reproduce the runs and compare new results.
## 架构

```
k6 (open model / closed loop)
   │  POST /api/coupons/{id}/claim?userId=..&mode=naive|lock|redis
   ▼
nginx :8080  (only in the scale overlay; base compose exposes the single app directly)
   │  round-robin, keepalive, re-resolves Docker DNS on scale up/down
   ▼
Spring Boot app × N  (stateless, 2 vCPU each in the scale overlay)
   ├──► PostgreSQL   (coupon, coupon_claim)
   ├──► Redis        (stock, claimed users, distributed lock, rate-limit ZSET)
   └──► Kafka topic "coupon-claimed" (12 partitions, key = userId)
             └──► ClaimEventConsumer (same JVM) ──► PostgreSQL（幂等落库，逐条或批量）
```

Base `docker-compose.yml` 仍然是单实例、直接暴露 8080，`scripts/run-claim-experiments.ps1` 的课程实验不变。
`deploy/docker-compose.scale.yml` 是叠加层：去掉 app 的固定端口，加 nginx，给每个 app 副本 2 vCPU / 1.5 GB 上限。


## 接口（Step 1.1：创建 → 发放 → 领取 → 资格校验 → 核销）

| 接口 | 作用 |
|---|---|
| `POST /api/coupons` | 创建券（DRAFT）。可选 `minOrderAmount`、`validFrom`、`validUntil` |
| `POST /api/coupons/{id}/issue` | 发放：状态改为 ACTIVE，库存和已领用户集合加载进 Redis（`/preload` 是同一个接口） |
| `POST /api/coupons/{id}/claim?userId=&mode=` | 领取，三种实现见下表 |
| `GET /api/coupons/{id}/eligibility?userId=&orderAmount=` | 资格校验：已发放、在有效期内、用户已领且未核销、订单金额达到门槛 |
| `POST /api/coupons/{id}/redeem?userId=&orderAmount=&orderId=` | 核销：条件 UPDATE（`... AND status = 'CLAIMED'`）保证一张券最多核销一次 |

资格校验和核销读写 PostgreSQL，不在 flash sale 的热路径上，所以不影响领券实验的数字。Redis 路径领到的券要等 consumer 落库后才能核销（最终一致）。

## 三种领券实现（同一个接口，用 `mode` 参数切换）

| mode | 做法 | 对应课程步骤 | 预期 |
|---|---|---|---|
| `naive` | SELECT 库存 → SELECT 是否已领 → UPDATE 库存 = 读到的值 - 1 → INSERT claim，共 4 条 SQL，不加锁 | Phase 1：Step 1.2 / 1.3 / 1.4 | **会超卖**（lost update） |
| `lock` | 同样 4 条 SQL，外面包一层 Redis 分布式锁（`SET NX PX` + Lua compare-and-delete 释放） | Phase 2：Step 2.1 / 2.2 | 不超卖，但同一张券的请求被串行化，吞吐量低 |
| `redis` | 库存预加载到 Redis；一个 Lua script 原子完成"查重 → 查库存 → DECR → SADD"；ZSET 滑动窗口限流；成功后发 Kafka 事件，异步落库 | Phase 3：Step 3.1 / 3.2 / 3.3；Phase 4：Step 4.1 / 4.2 | 不超卖，同步路径上 0 条 SQL |

`redis` 路径默认把限流和领券合并成一次 Lua（`COMBINED_RATE_LIMIT=false` 可以退回两段式做对照），
`VIRTUAL_THREADS=true` 打开虚拟线程。两者的实测对比见下面 Step 2。

Consumer 有两种落库方式（Step 4.4），用环境变量 `COUPON_CONSUMER_BATCH` 切换：
- `false`（默认）：每条消息一个事务、一条 INSERT
- `true`：每次 poll 一个事务，一条多行 `INSERT ... ON CONFLICT DO NOTHING RETURNING`，再按券汇总扣库存，只扣真正插入的行数

代码在 `backend/src/main/java/com/coursework/coupon/`，Lua 脚本在 `backend/src/main/resources/lua/`。

## 瓶颈与水平扩展（新增，数字均为本机实测）

这一节回答三个问题：单机到底卡在哪、加副本能不能线性涨、热路径还有多少空间。
完整方法、原始 CSV 和踩坑记录在 `perf/README.md`，结果在 `perf/out/`。

### Step 0：先量瓶颈，别先加机器

固定到达率压 `redis` 路径，同时采样 `docker stats`（100% = 1 核）：

| 目标 RPS | 实际 RPS | p95 | app 核数 | redis 核数 | kafka 核数 | k6 核数 |
|---|---|---|---|---|---|---|
| 6,000 | 5,957 | 1.1 ms | 3.10 | 0.33 | 0.25 | 1.17 |
| 12,000 | 11,959 | 2.3 ms | 4.27 | 0.58 | 0.32 | 2.48 |
| 20,000 | 16,994 | 204 ms | 7.21 | 0.68 | 0.30 | 4.19 |

结论：**Redis 不是瓶颈**（17K RPS 时只用了 0.68 核），app 是唯一随负载增长的组件，所以先扩 app。
另外 20K 那行的 204 ms 不是服务端延迟：k6 的 `maxVUs: 3000` 在延迟变大后只能维持约 17K 在途请求，
是压测机自己先到顶了。这正是后面改用闭环压测的原因。

### Step 1：3 个无状态副本 + nginx

```bash
# 新卷上先起 1 个副本等它就绪，再扩到 3（每个副本启动都会跑 schema.sql）
docker compose -f docker-compose.yml -f deploy/docker-compose.scale.yml up -d --build --scale app=1
docker compose -f docker-compose.yml -f deploy/docker-compose.scale.yml up -d --scale app=3
```

nginx 用 `resolve` + Docker DNS 做服务发现，扩缩容不会留下失效的上游 IP；每个 app 副本限制 2 vCPU / 1.5 GB。

闭环压测（1600 VUs，先预热 60 s，再测 45 s；consumer 停掉，只测同步领券路径）：

| 副本数 | 实际 RPS | 相对 1 副本 | 中位延迟 | p95 | app 总核数 | 每副本核数 | redis | nginx | k6 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 7,095 | 1.00× | 219 ms | 292 ms | 1.95 | 1.95 | 0.23 | 0.59 | 1.36 |
| 2 | 14,299 | **2.02×** | 108 ms | 199 ms | 3.89 | 1.94 | 0.47 | 1.16 | 2.69 |
| 3 | 19,712 | **2.78×** | 84 ms | 164 ms | 5.74 | 1.91 | 0.62 | 1.55 | 3.74 |

- 每个副本都稳定吃满约 1.9/2 核，2 副本是 2.02×，3 副本是 2.78×（线性的 93%）。
- 延迟是闭环满载下的排队延迟，不是服务时间；只用来比较曲线，不要当 SLO。
- 共享组件都没到顶：Redis 0.62 核、nginx 1.55 核、k6 3.74 核。再往上扩，k6 和 nginx 会先成为新的天花板。

### Step 4：Kafka key 的真相与预期相反

同一张热门券，只改 message key，12 分区、6 个消费线程：

| 消费模式 | key | 用了几个分区 | 追平时间 |
|---|---|---|---|
| 逐条 | couponId | 1 | 86.7 s |
| 逐条 | userId | 12 | 93.0 s |
| 批量 | couponId | 1 | 18.2 s |
| 批量 | userId | 12 | 16.2 s |

`userId` 确实把消息从 1 个分区摊到 12 个（每个约 1.2 万条），但追平时间几乎没变。
真正的串行点是消费端对同一行做的 `UPDATE coupon SET stock = stock - 1 WHERE id = ?`：
逐条模式下每条消息一个事务，全部排队在这把行锁上，所以 1.7K/s 与分区数无关；
批量模式把 500 条聚合成一次 UPDATE，才把追平从 86.7 s 降到 18.2 s（4.8×）。
结论：key 要改（消除分区倾斜，为以后消费端并行做准备），但它不是这次吞吐的主因。
详见 `perf/out/kafka_key.md`。

### Step 2：热路径（合并 Lua / 虚拟线程）

单副本、2 vCPU、consumer 停掉，闭环 1600 VUs，每个配置单独重启并预热 45 s：

| 配置 | RPS | 相对基线 | app 核数 | evalsha / 请求 |
|---|---|---|---|---|
| 两段 Lua + 平台线程 | 5,096 | 1.00× | 1.81 | 2 |
| 合并 Lua + 平台线程 | 7,110 | 1.40× | 2.02 | 1 |
| 两段 Lua + 虚拟线程 | 9,215 | 1.81× | 1.68 | 2 |
| 合并 Lua + 虚拟线程 | **11,382** | **2.23×** | 1.77 | 1 |

- 合并 Lua 把限流和领券放进一次 EVALSHA，省掉一次 RTT；平台线程下 +40%。
- 虚拟线程把 400 个平台线程抢 2 核的上下文切换开销去掉（请求大部分时间在等 Redis），+60%～80%。
- 两者叠加在同样 2 vCPU 下到 11.4K；单独复核跑出 11,360，可复现。
- 注意：扩展曲线用的是平台线程（7.1K/副本），这一节是热路径优化后的单副本数字，两组不要混着引用。
  `merged+platform` 的 7,110 和容量曲线的 7,095 对得上，说明基线不是预热不足造成的。

### Step 3：为什么没做 Redis Cluster 分桶

- 单机上所有 Redis 节点共享同一块 CPU、内存和网卡，起 3 主集群不会增加吞吐，只会多一层 cluster 协议开销。
- 这次实测 Redis 在 20K RPS 时只用了 0.62 核，它不是瓶颈；先分桶是在优化错误的目标。
- 分桶会改变去重语义（同用户固定到一个桶，桶间售罄不均需要跨桶重试 + 全局去重），
  现有“超卖/重复领取”实验的正确性证明要全部重做。

如果以后真的到了单 key 上限，设计是：库存 10000 拆 8 个桶 `{c1:b0}:stock`…`{c1:b7}:stock`，
`bucket = hash(userId) % 8`，去重集合按桶拆；接受尾部少量不均衡，或跨桶重试并加全局去重 key。
前提是先把 Redis 打到单核上限——这次的数据说明还没到。

## 怎么跑

1. 打开 **Docker Desktop**，等左下角显示 *Engine running*。
2. 双击 **`scripts/windows/1_run_all.bat`**。会先清掉旧容器和数据，再重新构建。所有实验加起来约 20 分钟。
3. 结果在 **`results\summary.md`**；完整日志在 `results\run_log.txt` 和 `results\app_log.txt`。上一次的结果会自动移到 `results_prev_<时间>\`，不会被覆盖。
   `summary.md` 是上一次运行的快照；当前代码默认 `key=userId`、12 分区、6 个消费线程，重跑后 consumer 追平时间会和旧快照不同。
4. 做完后双击 `scripts/windows/2_stop_and_clean.bat`，停掉容器并删除数据。
5. 扩展/热路径实验单独跑，不影响课程实验：

```powershell
powershell -ExecutionPolicy Bypass -File perf\bottleneck.ps1          # Step 0 瓶颈采样
powershell -ExecutionPolicy Bypass -File perf\capacity_test.ps1 -Instances "1,2,3" -VUs 1600
powershell -ExecutionPolicy Bypass -File perf\kafka_key_test.ps1 -Batch false
powershell -ExecutionPolicy Bypass -File perf\kafka_key_test.ps1 -Batch true
powershell -ExecutionPolicy Bypass -File perf\hotpath_test.ps1
```

结果写到 `perf\out\*.md`。`-File` 模式下 `-Instances` 必须带引号：`1,2,3` 会被 PowerShell 绑成一个整数 `123`
（这个坑真的创建过 123 个副本，脚本现在会拒绝大于 6 的值）。


## 实验

- **实验 1（超卖，Step 1.3 / 2.1 / 3.3）**：库存 = 1，100 个用户同时领，看三种 mode 各有几个人领到。
- **实验 1b（券的生命周期，Step 1.1）**：发放前领取、重复领取、未领用户、订单金额不够、过期、未到开始时间、正常核销、重复核销，逐项对照预期；再让 50 个请求同时核销同一张券，看是否只有 1 个成功。
- **实验 2（压测，Step 1.4 / 2.2 / 3.3）**：固定请求速率（open model），每个请求是不同用户，库存足够大。记录实际 RPS、median / p95 / p99、错误率，以及每个请求在同步路径上执行了几条 SQL。
- **实验 3（对账，Step 4.3）**：最后一轮 redis 压测结束后，等 consumer 把领券记录全部写进 PostgreSQL，比较两边的条数和库存。
- **实验 4（consumer 崩溃重启，Phase 5）**：consumer 还没追平时用 SIGKILL 杀掉 app，再重新启动。检查有没有丢、有没有重复扣库存，以及重启后跳过了多少条重复投递的消息。注意：被杀掉的旧 consumer 要等 Kafka session timeout（默认 45 秒）才会被踢出 group，所以恢复时间里包含这段等待。
- **实验 5（逐条 vs 批量落库，Step 4.4）**：同样的负载各跑一次，比较 consumer 追平的时间。
