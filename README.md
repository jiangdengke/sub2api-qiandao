# sub2api-qiandao

一个给 Sub2API 自定义 iframe tab 使用的每日签到服务。用户在 Sub2API 左侧菜单打开签到页后，服务端会验证当前 Sub2API 登录用户，并用管理员 API Key 给该用户增加余额。

## 特性

- 管理员 API Key 只保存在服务端，不暴露给浏览器。
- 每个用户每天只能签到一次，按 `CHECKIN_TIMEZONE` 计算日期。
- 使用本地 JSON 文件持久化签到记录，适合单实例部署。
- 前端可直接作为 Sub2API 自定义菜单 iframe 页面。
- 零 npm 依赖，Node.js 20+ 即可运行。

## 快速启动

```bash
cp .env.example .env
```

编辑 `.env`，至少配置：

```dotenv
PUBLIC_BASE_PATH=/checkin
SUB2API_BASE_URL=http://127.0.0.1:3000
SUB2API_ADMIN_API_KEY=your-admin-api-key
CHECKIN_AMOUNT=0.1
CHECKIN_UNIT=USD
CHECKIN_ADMIN_PASSWORD=change-this-password
```

本地运行：

```bash
npm run start:env
```

Docker Compose：

```bash
docker compose up -d --build
```

也可以直接使用 GitHub Packages 发布的镜像：

```bash
docker run -d \
  --name sub2api-qiandao \
  --restart unless-stopped \
  --env-file .env \
  -p 8787:8787 \
  -v "$(pwd)/data:/app/data" \
  ghcr.io/jiangdengke/sub2api-qiandao:latest
```

健康检查：

```bash
curl http://127.0.0.1:8787/checkin/healthz
```

查看运行日志：

```bash
docker logs -f sub2api-qiandao
```

管理端：

```text
http://127.0.0.1:8787/checkin/admin/
```

反代到 Sub2API 同源后：

```text
https://你的-sub2api-域名/checkin/admin/
```

## 镜像发布

推送到 `master` 分支或推送 `v*` tag 时，GitHub Actions 会构建并发布多架构镜像到 GitHub Container Registry：

```text
ghcr.io/jiangdengke/sub2api-qiandao:latest
ghcr.io/jiangdengke/sub2api-qiandao:<tag>
ghcr.io/jiangdengke/sub2api-qiandao:sha-<commit>
```

## 日志

服务会输出带事件名的 JSON 日志，方便 `docker logs`、Loki 或其他日志系统采集。

启动成功示例：

```text
[sub2api-qiandao] {"time":"2026-05-31T07:30:00.000Z","level":"info","event":"service.started","port":8787,"publicBasePath":"/checkin","sub2apiBaseUrl":"http://sub2api:3000","checkinAmount":0.1,"checkinUnit":"USD","timezone":"Asia/Shanghai"}
```

Sub2API 连接探测成功示例：

```text
[sub2api-qiandao] {"time":"2026-05-31T07:30:01.000Z","level":"info","event":"sub2api.connection.ok","baseUrl":"http://sub2api:3000","authMePath":"/api/v1/auth/me","status":401}
```

`status` 是 `401` 也表示目标服务可连接，因为启动探测不会携带用户登录态。

用户签到成功示例：

```text
[sub2api-qiandao] {"time":"2026-05-31T07:31:00.000Z","level":"info","event":"checkin.success","user":{"id":"12","name":"demo","email":"demo@example.com"},"date":"2026-05-31","amount":0.1,"unit":"USD","upstreamStatus":200,"createdAt":"2026-05-31T07:31:00.000Z"}
```

重复签到会输出 `checkin.duplicate`，余额接口失败会输出 `sub2api.balance.failed`。

## 奖励规则

默认情况下，签到奖励使用 `CHECKIN_AMOUNT` 的固定金额。你也可以配置多个随机档位，每个档位有自己的权重，用户签到时按权重随机抽取。

推荐通过管理端配置：

```text
/checkin/admin/
```

管理端使用 `CHECKIN_ADMIN_PASSWORD` 登录，只能配置签到奖励规则，不会暴露 Sub2API Admin API Key。

也可以通过环境变量设置初始档位：

```dotenv
CHECKIN_REWARD_RULES=0.05:80:Small,0.1:15:Normal,1:5:Lucky
```

上面的含义是：

- `0.05` 权重 `80`
- `0.1` 权重 `15`
- `1` 权重 `5`

概率按权重占比计算，所以分别是 `80%`、`15%`、`5%`。管理端保存后，规则会写入 `DATA_FILE`，后续重启仍然生效。

## Sub2API 中配置菜单

推荐把本服务反代到 Sub2API 同源路径，例如：

```nginx
location /checkin/ {
  proxy_pass http://127.0.0.1:8787/checkin/;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

然后在 Sub2API 管理后台的自定义菜单里添加：

```text
名称：每日签到
URL：https://你的-sub2api-域名/checkin/
可见性：用户
打开方式：iframe
```

同源部署很重要：如果 Sub2API 前端把登录 token 存在 `localStorage`，iframe 只有在同源时才能读取并转交给签到服务验证。服务端也会转发 cookie 登录态，因此 cookie 鉴权部署也可工作。

## 工作流程

1. 用户打开 Sub2API 左侧的“每日签到”菜单。
2. iframe 前端读取当前 Sub2API 登录 token，或携带同源 cookie 请求本服务。
3. 本服务调用 `SUB2API_AUTH_ME_PATH` 验证用户并解析用户 ID。
4. 用户点击签到后，本服务检查 `user_id + date` 是否已存在。
5. 未签到时，本服务调用管理员余额接口给用户加余额。
6. 写入 `DATA_FILE`，后续重复点击只返回已签到。

默认余额接口请求体为：

```json
{
  "balance": 0.05,
  "operation": "add",
  "notes": "Daily check-in 2026-05-31 0.05 USD"
}
```

如果你的 Sub2API 版本接口字段不同，可以通过环境变量调整：

```dotenv
SUB2API_BALANCE_PATH_TEMPLATE=/api/v1/admin/users/{id}/balance
SUB2API_BALANCE_OPERATION=add
SUB2API_BALANCE_AMOUNT_FIELD=balance
SUB2API_ADMIN_AUTH_HEADER=x-api-key
SUB2API_ADMIN_AUTH_VALUE=
```

`SUB2API_ADMIN_AUTH_VALUE` 为空时会使用 `SUB2API_ADMIN_API_KEY`。如果你的实例要求 `Authorization` 头，可以这样配：

```dotenv
SUB2API_ADMIN_AUTH_HEADER=Authorization
SUB2API_ADMIN_AUTH_VALUE=Bearer your-admin-api-key
```

## 生产注意事项

- 当前 JSON 存储只适合单实例。如果要多副本部署，应改成 PostgreSQL、MySQL 或 Redis 原子去重。
- 如果反代时去掉了 `/checkin` 前缀，把 `PUBLIC_BASE_PATH=/`。
- 如果用户接口不是 `/api/v1/auth/me`，修改 `SUB2API_AUTH_ME_PATH`。
- 如果前端无法自动识别 token，可把实际 localStorage key 加到 `PUBLIC_TOKEN_STORAGE_KEYS`。
