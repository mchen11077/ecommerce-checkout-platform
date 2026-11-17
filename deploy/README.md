# 优惠券服务发布与验收

## 本地发布演练

安装 Docker Compose、Node 22 和 pnpm 10.34.9。运行以下命令。验收使用新命名的 Compose 项目、独立数据库和本地端口 5186、8186、9196。测试结束清理该项目。排查失败时可加 `-KeepRunning`，用脚本打印的项目名查看容器。

```powershell
pnpm --dir e2e install --frozen-lockfile
pnpm --dir e2e exec playwright install chromium webkit
./scripts/verify-release.ps1
```

## 发布到目标环境

1. 准备 PostgreSQL、OIDC 提供方和 HTTPS 域名。给迁移用户 DDL 权限，给应用用户业务表和序列的必要权限。数据库证书必须能被迁移容器和应用信任。将 `release.env.example` 复制为 `deploy/.env`，填入实际配置与独立密钥。保管环境文件，确保部署和日志系统不泄露其内容。
2. 在身份服务注册保密客户端，登记实际商店地址的 `/login/oauth2/code/coupon` 回调和退出回调。ID Token 包含字符串类型的正整数 `coupon_user_id` 和由身份服务分配的 `coupon_roles`。本地的 Keycloak 演练配置提供了映射示例。
3. 将 HTTPS 反代配置到主机的 8088，参考 `Caddyfile.example`。若接入同机反代，按实际网络设置 Nginx 的可信 real-IP 来源，使限流按真实客户端区分。直接访问演练环境时按 TCP 来源计数。验证 Cookie 带有 Secure、HttpOnly 和 SameSite=Lax。
4. 给镜像指定不可变的发布标签。备份数据库后运行发布命令。迁移成功后 Compose 启动应用，Nginx 提供构建好的静态前端。部署入口只有回环端口，由 HTTPS 入口转发。

```sh
docker compose --project-directory . --env-file deploy/.env -f deploy/docker-compose.release.yml build
docker compose --project-directory . --env-file deploy/.env -f deploy/docker-compose.release.yml run --rm migrate
docker compose --project-directory . --env-file deploy/.env -f deploy/docker-compose.release.yml up -d --no-build
```

5. 在目标环境确认 HTTPS 登录、领取与结账正常，检查 Prometheus 抓取与告警。将告警转接到实际值班渠道。Prometheus 管理端口只在主机回环地址开放。生产反代应保留请求 ID，以便从浏览器响应关联 Nginx 日志。

## 升级、回滚与恢复

- 数据库变更在 `migrate.sql` 中追加新版本。版本 1 使用已有的兼容建表脚本，发布后将其视为已应用基线。版本 2 增加券包索引。PostgreSQL 事务锁阻止两个迁移同时执行。升级前在恢复出的备份库上验证，优先使用兼容旧版本应用的增量变更。
- 应用回滚使用上一个经过验证的前后端镜像标签，更新环境变量后运行 `up -d --no-build --no-deps app web`。先确认旧版兼容当前表结构，再验证登录和订单回放。
- 按数据库服务的备份策略保存离线备份。恢复到新库，校验库存、领取记录、回执和权限，再切换连接。演练脚本用 `pg_dump` 和 `pg_restore` 核对三张业务表的内容。外部身份服务和监控配置也应有自己的备份。
- 验收演练用 80 个请求观察本机网关限流及延迟，另用两个真实账号竞争一张库存。根据预计流量和目标机器补持续负载测试并确定容量目标。
