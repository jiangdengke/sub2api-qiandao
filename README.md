# sub2api-qiandao

一个给 Sub2API 自定义 iframe tab 使用的每日签到服务。用户在 Sub2API 左侧菜单打开签到页后，服务端会验证当前 Sub2API 登录用户，并用管理员 API Key 给该用户增加余额。

## 特性

- 管理员 API Key 只保存在服务端，不暴露给浏览器。
- 每个用户每天只能签到一次，按 `CHECKIN_TIMEZONE` 计算日期。
- 使用本地 SQLite 文件持久化签到记录和奖励规则，不需要单独启动数据库服务。
- 前端可直接作为 Sub2API 自定义菜单 iframe 页面。
- 用户页包含月历视图，可查看每天是否签到以及当天领取金额。
- 零 npm 依赖，Node.js 24+ 即可运行。

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
# 可选：仿 New API 的区间随机奖励。未配置时等同固定 CHECKIN_AMOUNT。
# CHECKIN_REWARD_MODE=range_random
# CHECKIN_MIN_AMOUNT=0.1
# CHECKIN_MAX_AMOUNT=2
# CHECKIN_AMOUNT_STEP=0.1
CHECKIN_UNIT=USD
CHECKIN_ADMIN_PASSWORD=change-this-password
CHECKIN_DB_FILE=./data/checkins.db
```

本地运行：

```bash
npm run start:env
```

Docker Compose：

```bash
docker compose pull
docker compose up -d
```

默认 `docker-compose.yml` 使用 GitHub Packages 发布的镜像，不需要本机构建，因此不会拉取 `node:24-alpine` 基础镜像。

如果需要本地构建镜像：

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

也可以直接使用 Docker 命令运行发布镜像：

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

默认情况下，签到奖励使用 `CHECKIN_AMOUNT` 的固定金额。管理端支持两种模式：

- `New API 区间随机`：配置最小金额、最大金额和步长，签到时在区间内等概率抽取一个金额。比如 `0.1` 到 `2`、步长 `0.1`，会从 `0.1、0.2 ... 2` 中随机选一个。
- `权重档位随机`：配置多个金额档位，每个档位有自己的金额、权重和名称，签到时按权重随机抽取。

推荐通过管理端配置：

```text
/checkin/admin/
```

管理端使用 `CHECKIN_ADMIN_PASSWORD` 登录，可以配置奖励模式、区间随机参数、权重档位和余额备注前缀，不会暴露 Sub2API Admin API Key。

也可以通过环境变量设置首次初始化策略。区间随机示例：

```dotenv
CHECKIN_REWARD_MODE=range_random
CHECKIN_MIN_AMOUNT=0.1
CHECKIN_MAX_AMOUNT=2
CHECKIN_AMOUNT_STEP=0.1
```

如果更想要“大额低概率”的抽奖效果，可以使用权重档位：

```dotenv
CHECKIN_REWARD_MODE=weighted_random
CHECKIN_REWARD_RULES=0.05:80:Small,0.1:15:Normal,1:5:Lucky
```

上面的含义是：

- `0.05` 权重 `80`
- `0.1` 权重 `15`
- `1` 权重 `5`

概率按权重占比计算，所以分别是 `80%`、`15%`、`5%`。管理端保存后，规则会写入 SQLite 数据库，后续重启仍然生效。后续修改权重时，直接在 `/checkin/admin/` 页面调整即可。

余额备注前缀也可以在管理端修改。默认备注格式类似：

```text
Daily check-in 2026-05-31 0.05 USD
```

其中 `Daily check-in` 就是备注前缀。

## SQLite 存储

SQLite 不需要单独启动服务。签到服务会直接读写一个本地数据库文件：

```dotenv
CHECKIN_DB_FILE=./data/checkins.db
```

Docker 部署时，只要继续挂载 `./data:/app/data`，数据库文件就会保存在宿主机：

```text
./data/checkins.db
```

如果旧版本已经生成过 JSON 文件：

```text
./data/checkins.json
```

服务启动时会在 SQLite 为空的情况下自动迁移旧 JSON 里的签到记录和奖励规则。迁移完成后，新的写入只进入 SQLite。

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
6. 写入 SQLite，后续重复点击只返回已签到。

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

- SQLite 适合单实例部署。如果要多副本、多服务器共享写入，应改成 PostgreSQL、MySQL 或 Redis 原子去重。
- 如果反代时去掉了 `/checkin` 前缀，把 `PUBLIC_BASE_PATH=/`。
- 如果用户接口不是 `/api/v1/auth/me`，修改 `SUB2API_AUTH_ME_PATH`。
- 如果前端无法自动识别 token，可把实际 localStorage key 加到 `PUBLIC_TOKEN_STORAGE_KEYS`。
