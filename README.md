# na_hitokoto_history

`na_hitokoto_history` 是 `na_hitokoto` 系列应用的历史内容存储服务。

它运行在 Cloudflare Workers 上，用 D1 保存完整历史文本，用 KV 保存少量公开随机历史。当前生产域名为：

```text
https://history.hitokoto.natsuki.cloud
```

## 当前状态

- 生产环境已经部署并通过端到端测试。
- D1 数据库已经应用 `0001_create_history.sql` 和 `0002_simplify_history_id_check.sql`。
- `POST /add`、`POST /match`、`GET /get`、`POST /delete` 均已在生产环境验证可用。
- `GET /get` 刚部署或库为空时可能返回 `{}`，这是正常状态；cron 会每小时刷新 KV。

## 绑定与配置

`wrangler.toml` 当前使用：

```toml
[[d1_databases]]
binding = "HISTORY_DB"
database_name = "na_hitokoto_history"
database_id = "9d25f197-f5ed-4eb0-840c-e375431e7e68"

[[kv_namespaces]]
binding = "kv_public_get"
id = "0b785a0c925747bc99ad198106cf8e88"
```

KV namespace 名称：

```text
na_hitokoto_history_cache
```

业务鉴权 secret：

```text
API_TOKEN
```

设置方式：

```sh
npm exec wrangler -- secret put API_TOKEN
```

调用受保护接口时使用：

```http
Authorization: Bearer <API_TOKEN>
Content-Type: application/json
```

## 部署与迁移

安装依赖后可执行：

```sh
npm test
npm exec wrangler -- d1 migrations apply na_hitokoto_history --remote
npm exec wrangler -- deploy
```

注意：Worker 自动部署不会自动执行 D1 migration。新增或修改 `migrations/` 后，仍需要手动运行：

```sh
npm exec wrangler -- d1 migrations apply na_hitokoto_history --remote
```

## D1 表结构

数据表是 kv 结构：

- `id`：16 位大写 HEX，主键
- `content`：文本内容
- `created_at`：Unix 秒级时间戳
- `updated_at`：Unix 秒级时间戳

写入时会根据 `MAX_HISTORY_ROWS` 控制最大保留数量。达到上限后，`POST /add` 会先删除最早的历史记录，再写入新内容。

当前 ID 约束使用：

```sql
CHECK (length(id) = 16)
CHECK (id = upper(id))
CHECK (id NOT GLOB '*[^0-9A-F]*')
```

不要改回 16 段 `[0-9A-F]` 的 GLOB 写法。D1 会在插入时触发：

```text
D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR
```

## 接入 na_hitokoto_content

`na_hitokoto_content` 应该在生成内容并写入自身 `TEXT_CACHE` 后，调用 history 的 `POST /add`。

推荐新增两个配置：

```js
const HISTORY_API_URL = "https://history.hitokoto.natsuki.cloud/add";
```

Cloudflare secret：

```text
HISTORY_API_TOKEN
```

如果暂时不想拆分权限，也可以让 `HISTORY_API_TOKEN` 和现有 `ACCESS_TOKEN` 使用同一个值。

如果上游还没有 ID 生成逻辑，可以使用下面的函数生成 16 位大写 HEX：

```js
function createHistoryId() {
  while (true) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const id = [...bytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();

    if (id !== "FFFFFFFFFFFFFFFF") {
      return id;
    }
  }
}
```

示例函数：

```js
async function saveHistoryContent(env, generatedId, generatedContent) {
  const token = env.HISTORY_API_TOKEN ?? env.ACCESS_TOKEN;
  if (!token) {
    throw new Error("Missing HISTORY_API_TOKEN or ACCESS_TOKEN.");
  }

  const response = await fetch(HISTORY_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      new_content_id: generatedId,
      new_content: generatedContent,
    }),
  });

  if (response.status === 409) {
    throw new Error("History id already exists. Generate a new id and retry.");
  }

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`History save failed: ${response.status} ${message}`);
  }

  return await response.json();
}
```

`na_hitokoto_content` 的接入位置建议在生成内容成功后：

```js
const generatedContent = await callOpenAIStyleAPI(...);
const generatedId = createHistoryId();
await env.TEXT_CACHE.put(STORAGE_KEY, generatedContent);
await saveHistoryContent(env, generatedId, generatedContent);
return generatedContent;
```

上游必须保证：

- `generatedId` 是 16 位 HEX，建议传大写。
- `generatedId` 不能是 `FFFFFFFFFFFFFFFF`，这个值是随机查询保留 ID。
- `generatedContent` 不能刚好是 16 位 HEX，否则 `/add` 会拒绝。
- 如果 `/add` 返回 `409 duplicate_id`，上游应重新生成 ID 后再试。

## API

### `POST /add`

用途：新增历史内容。供上游 `na_hitokoto_content` 调用。

需要 Bearer token。

请求：

```json
{
  "new_content_id": "0123456789ABCDEF",
  "new_content": "stored text"
}
```

也兼容：

```json
{
  "id": "0123456789ABCDEF",
  "content": "stored text"
}
```

成功响应：

```json
{
  "ok": true,
  "id": "0123456789ABCDEF",
  "inserted": 1
}
```

常见错误：

- `400 id_must_be_16_hex`
- `400 reserved_id`
- `400 content_must_not_be_16_hex`
- `400 content_must_not_be_empty`
- `409 duplicate_id`
- `500 database_write_failed`

`database_write_failed` 只会在已通过鉴权的 `/add` 请求中返回，用于上游排障。

### `POST /match`

用途：批量查询历史内容。

需要 Bearer token。

请求：

```json
{
  "key": ["0123456789ABCDEF", "some content", "FFFFFFFFFFFFFFFF"]
}
```

匹配规则：

- `key` 中的 item 如果是 16 位 HEX，则按 content id 查询内容。
- `key` 中的 item 如果不是 16 位 HEX，则按内容查询 id。
- `FFFFFFFFFFFFFFFF` 是保留随机 ID，会返回随机内容。
- 随机 ID 返回时，map 的 key 会替换为真实 id，不会返回 `FFFFFFFFFFFFFFFF`。

全部成功：

```json
{
  "data": {
    "0123456789ABCDEF": "stored text",
    "some content": "FEDCBA9876543210"
  },
  "all_succeed": true,
  "failed": []
}
```

部分成功：

```json
{
  "data": {
    "0123456789ABCDEF": "stored text"
  },
  "all_succeed": false,
  "failed": ["missing content"]
}
```

全部失败时返回 HTTP `404`：

```json
{
  "data": {},
  "all_succeed": false,
  "failed": ["missing content"]
}
```

### `GET /get`

用途：公开获取少量随机历史内容。

不需要 Bearer token。

响应：

```json
{
  "0123456789ABCDEF": "stored text"
}
```

数据来自 KV 的 `random_history` key。cron 每小时刷新一次。KV miss 时会从 D1 重建并写回 KV；如果 D1 为空，则返回 `{}`。

当前最多返回 128 条历史内容。D1 中不足 128 条时，返回实际存在的数量。

### `POST /delete`

用途：删除历史内容，主要作为备用维护接口。

需要 Bearer token。

请求：

```json
{
  "id": "0123456789ABCDEF"
}
```

也兼容：

```json
{
  "content_id": "0123456789ABCDEF"
}
```

成功响应：

```json
{
  "ok": true,
  "id": "0123456789ABCDEF",
  "deleted": 1,
  "meta": {}
}
```

`meta` 是 D1 返回的执行信息，字段可能随 Cloudflare 运行时变化；上游只应依赖 `deleted`。

不存在时返回 HTTP `404`：

```json
{
  "error": "id_not_found",
  "id": "0123456789ABCDEF",
  "deleted": 0
}
```

## 限额策略

当前默认值：

```toml
MAX_BATCH_SIZE = "25"
MAX_CONTENT_LENGTH = "2000"
PUBLIC_RANDOM_SIZE = "128"
PUBLIC_RANDOM_KV_KEY = "random_history"
D1_QUERY_BUDGET = "45"
MAX_HISTORY_ROWS = "100000"
```

设计目标是适配 Cloudflare Free Plan：

- Workers Free：每天 100,000 requests。
- D1 Free：单次 Worker invocation 最多 50 次 D1 query。
- D1 Free：每天 5,000,000 rows read，100,000 rows written。
- D1 Free：单库 500 MB，账户总计 5 GB。
- KV Free：每天 100,000 reads，1,000 writes to different keys。
- KV 同 key 写入限制：1 write/sec。

实现上的保护：

- `/match` 会先估算 D1 query 数，超过 `D1_QUERY_BUDGET` 直接拒绝。
- `FFFFFFFFFFFFFFFF` 随机查询最坏需要 2 次 D1 query。
- `/get` 重建 KV 时最多执行 2 次 D1 query，默认最多返回 128 条。
- `/add` 会在行数达到 `MAX_HISTORY_ROWS` 时自动删除最早内容，避免 D1 持续增长到容量上限。
- cron 每小时写一次同一个 KV key，每天约 24 次，低于 KV 写入限制。

## 本地测试

```sh
npm test
```

当前测试覆盖：

- add / match / get / delete 主流程
- Bearer token 鉴权
- payload 校验
- 16 位 HEX 与保留 ID 规则
- 全部 miss 返回 404
- 随机 ID 返回真实 ID
- KV miss 后从 D1 重建
- cron 刷新 KV
- 达到历史行数上限时自动删除最早记录
- D1 query budget
- D1 BigInt metadata JSON 序列化

## 生产 smoke test 结果

最近一次生产测试已通过以下业务逻辑：

- 未授权 `/add` 返回 `401`
- 错误 payload 返回 `400`
- `/add` 新增成功
- `/add` 重复 ID 返回 `409`
- 保留 ID `FFFFFFFFFFFFFFFF` 被拒绝
- 内容为 16 位 HEX 被拒绝
- `/match` 可按 ID 查内容
- `/match` 可按内容查 ID
- `/match` 部分失败时返回 `all_succeed: false`
- `/match` 全部失败时返回 HTTP `404`
- `FFFFFFFFFFFFFFFF` 随机查询返回真实 ID
- `/get` 返回 map
- `/delete` 删除成功
- 删除后再次 `/match` 返回 HTTP `404`
