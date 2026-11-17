# 性能与扩展实验

`results/summary.md` 是课程五个实验的历史快照。这里回答的是另外几个问题：

1. 单机上到底哪个容器先饱和？（Step 0）
2. 给 app 加副本、每个副本限 2 vCPU，吞吐能不能接近线性？（Step 1）
3. Kafka 用 couponId 做 key 是不是 consumer 追不上的原因？（Step 4）
4. 合并限流 Lua、开虚拟线程，单实例还能涨多少？（Step 2）

## 环境

- i7-14700K，20 核 / 28 线程，31.7 GB；Docker Desktop 分配 28 CPU / 16 GB。
- app（Spring Boot 3.3.5 / Java 21）、PostgreSQL 16、Redis 7.2、Kafka 3.7（单 broker）、k6 **全部在同一台机器**。
- 扩展实验每个 app 副本 `cpus: "2"`, `memory: 1.5g`, `-Xmx1g`；consumer 在扩展实验中停掉
  （`SPRING_KAFKA_LISTENER_AUTO_STARTUP=false`），只测同步领券路径。

## 脚本

| 脚本 | 作用 | 结果 |
|---|---|---|
| `bottleneck.ps1` | 单实例、不限制 CPU，6K/12K/20K 固定到达率，采样每个容器 CPU | `out/bottleneck.md` |
| `scale_test.ps1` | 开环（constant-arrival-rate）1/2/3 副本；保留作对照，结论被闭环取代 | `out/scale.md` |
| `capacity_test.ps1` | **闭环**（constant-vus，默认 1600 VUs）1/2/3 副本容量，预热 60 s | `out/capacity.md` |
| `kafka_key_test.ps1` | couponId vs userId，逐条/批量两种 consumer，统计分区分布与追平时间 | `out/kafka_key.md` |
| `hotpath_test.ps1` | 两段式 Lua vs 合并 Lua × 平台线程 vs 虚拟线程 | `out/hotpath.md` |

运行示例：

```powershell
powershell -ExecutionPolicy Bypass -File perf\bottleneck.ps1
powershell -ExecutionPolicy Bypass -File perf\capacity_test.ps1 -Instances "1,2,3" -VUs 1600
powershell -ExecutionPolicy Bypass -File perf\kafka_key_test.ps1 -Batch false
powershell -ExecutionPolicy Bypass -File perf\kafka_key_test.ps1 -Batch true
powershell -ExecutionPolicy Bypass -File perf\hotpath_test.ps1
```

`-Instances` 的引号不能省。PowerShell `-File` 模式会把 `1,2,3` 当成一个 token 绑成整数 `123`；
第一次跑的时候真的创建了 123 个副本（脚本现在会拒绝大于 6 的值，并在 `up` 前检查）。

## 方法论：四个会让数字说谎的坑

1. **`docker stats` 的 100% 是 1 核，不是整机。** 第一版脚本把 310% 写成 310 核，结论直接反了。
2. **开环压测的 `maxVUs` 会在高延迟时变成假天花板。** 20K 档只有 3000 VUs，p95 到 200 ms 后
   最多维持约 17K 在途请求，于是“实际 17K、丢 8.6 万次迭代”看起来像 app 到顶，其实是 k6 到顶。
   闭环固定 VU 没有这个反馈回路：VU 发完一个才发下一个，吞吐自然收敛到系统容量。
3. **JVM 需要 45–60 s 才热。** 同一个 2 副本配置，冷启动测 11.8K，充分预热后 14.0K，差 18%。
   所有容量数字都先预热 60 s，再测 45 s；热路径 A/B 每个配置单独重启，所以每个都要重新预热。
4. **端口/孤儿容器。** 从 scale 叠加层切回 base 时，nginx 不在 base 的 service 列表里，
   `down` 不会删它，8080 被占住导致 app 起不来。脚本统一用 `--remove-orphans`。

## 结果摘要

### 瓶颈（单实例，无 CPU 限制）

| 目标 RPS | 实际 RPS | app | redis | kafka | k6 |
|---|---|---|---|---|---|
| 6,000 | 5,957 | 3.10 | 0.33 | 0.25 | 1.17 |
| 12,000 | 11,959 | 4.27 | 0.58 | 0.32 | 2.48 |
| 20,000 | 16,994 | 7.21 | 0.68 | 0.30 | 4.19 |

Redis 始终不到 1 核，app 是唯一随负载增长的组件。详细分析见 `out/bottleneck.md`。

### 容量曲线（闭环 1600 VUs，2 vCPU/副本）

| 副本 | RPS | 相对 | app 总核 | 每副本 | redis | nginx | k6 |
|---|---|---|---|---|---|---|---|
| 1 | 7,095 | 1.00× | 1.95 | 1.95 | 0.23 | 0.59 | 1.36 |
| 2 | 14,299 | 2.02× | 3.89 | 1.94 | 0.47 | 1.16 | 2.69 |
| 3 | 19,712 | 2.78× | 5.74 | 1.91 | 0.62 | 1.55 | 3.74 |

每个副本都接近 2 核上限；2 副本是 2.02×，3 副本是 2.78×（线性的 93%）。
共享组件都没饱和，但 nginx（1.55 核）和 k6（3.74 核）已经开始变大，继续扩要先处理它们。
见 `out/capacity.md`。

### Kafka key

| 消费模式 | key | 分区数 | 追平 |
|---|---|---|---|
| 逐条 | couponId | 1 | 86.7 s |
| 逐条 | userId | 12 | 93.0 s |
| 批量 | couponId | 1 | 18.2 s |
| 批量 | userId | 12 | 16.2 s |

分区倾斜是真的，但不是追平慢的主因；主因是消费端对同一行 `coupon.stock` 的 UPDATE 行锁。
批量把 500 条聚合成一次 UPDATE，才带来 4.8× 的提升。见 `out/kafka_key.md`。

### 热路径（1 副本 / 2 vCPU / 1600 VUs）

| 配置 | RPS | 相对 | app 核 | evalsha/请求 |
|---|---|---|---|---|
| 两段 Lua + 平台线程 | 5,096 | 1.00× | 1.81 | 2 |
| 合并 Lua + 平台线程 | 7,110 | 1.40× | 2.02 | 1 |
| 两段 Lua + 虚拟线程 | 9,215 | 1.81× | 1.68 | 2 |
| 合并 Lua + 虚拟线程 | 11,382 | 2.23× | 1.77 | 1 |

合并 Lua 省掉一次 Redis 往返；虚拟线程消除 400 个平台线程抢 2 核的上下文切换。
叠加后同样 2 vCPU 到 11.4K，单独复核 11,360。`merged+platform` 与容量曲线的 7,095 一致。
见 `out/hotpath.md`。

## 局限

- 单机实验：3 个副本只用到 6 核，无法证明更多副本；再往上 nginx/k6/单实例 Redis 会先到顶。
- 没有做 Redis Cluster 和库存分桶：Redis 在 20K RPS 时只用了 0.62 核，分桶不会改变这次的结果，
  反而会破坏现有的去重正确性实验。设计取舍写在主 README 的 Step 3。
- consumer 和 API 在同一个 JVM；扩展实验停掉 consumer 以隔离同步路径，端到端容量会更低。
- 所有数字都是这台机器、这个 Docker Desktop 配置下的结果，换机器会变。
