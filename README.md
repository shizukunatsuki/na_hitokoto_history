# na_hitokoto_history

Cloudflare Worker for storing text history in D1 and exposing a small public random cache through KV.

## Bindings

- `HISTORY_DB`: D1 database, table `history`
- `kv_public_get`: KV namespace used by `GET /get`
- `API_TOKEN`: Worker secret used for protected endpoints

Set the secret with:

```sh
wrangler secret put API_TOKEN
```

Replace the placeholder `database_id` and KV `id` in `wrangler.toml`, then apply the migration:

```sh
npm run d1:migrate:remote
```

The default route is `history.hitokoto.natsuki.cloud`, matching the existing `na_hitokoto` Worker naming style. Change or remove the `routes` block in `wrangler.toml` if you want to use `workers.dev` or another domain.

## na_hitokoto integration

This Worker is ready to serve as the history backend, but the current `na_hitokoto_content` Worker must still call `POST /add` after it generates and caches new content.

Expected upstream call:

```js
await fetch("https://history.hitokoto.natsuki.cloud/add", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${env.ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    new_content_id: generatedId,
    new_content: generatedContent,
  }),
});
```

Use the same shared secret value for `na_hitokoto_content`'s outbound token and this Worker's `API_TOKEN`, or add a separate `HISTORY_API_TOKEN` secret upstream if you want to split permissions.

## API

Protected endpoints require:

```http
Authorization: Bearer <API_TOKEN>
Content-Type: application/json
```

### `POST /match`

Payload:

```json
{
  "key": ["0123456789ABCDEF", "some content", "FFFFFFFFFFFFFFFF"]
}
```

- 16-character hex keys are treated as content IDs and return `id -> content`.
- Non-hex keys are treated as content and return `content -> id`.
- `FFFFFFFFFFFFFFFF` returns one random content item and uses the real ID in the response map.
- If every key misses, the endpoint returns HTTP 404.

Response:

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

### `GET /get`

Returns a public random map from KV:

```json
{
  "0123456789ABCDEF": "stored text"
}
```

The scheduled Worker refreshes this KV entry every 30 minutes. If the KV entry is missing, `/get` rebuilds it from D1.

### `POST /add`

Payload:

```json
{
  "id": "0123456789ABCDEF",
  "content": "stored text"
}
```

Aliases are also accepted for upstream compatibility:

- `content_id`
- `new_content_id`
- `new_content`

The ID must be a non-reserved 16-character hex string. Content must be non-empty text and must not itself be a 16-character hex string.

### `POST /delete`

Payload:

```json
{
  "id": "0123456789ABCDEF"
}
```

Deletes the row if it exists. A missing ID returns HTTP 404.

## Limits

Configured in `wrangler.toml`:

- `MAX_BATCH_SIZE`: default `25`
- `D1_QUERY_BUDGET`: default `45`, rejects `/match` payloads that would use too many D1 queries in one Worker invocation
- `MAX_CONTENT_LENGTH`: default `2000`
- `PUBLIC_RANDOM_SIZE`: default `20`
- `PUBLIC_RANDOM_KV_KEY`: default `random_history`

The batch default leaves room under the Workers Free D1 query budget when a request contains reserved random IDs. Public random rebuilds use at most `PUBLIC_RANDOM_SIZE * 2` D1 queries, so the default `20` stays under the Free plan's 50 D1 queries per Worker invocation.

Cloudflare Free plan notes:

- Workers Free allows 100,000 requests per day.
- D1 Free allows 50 D1 queries per Worker invocation, 5 million rows read per day, 100,000 rows written per day, 500 MB per database, and 5 GB total storage.
- KV Free allows 100,000 reads per day, 1,000 writes to different keys per day, and 1 write per second to the same key.
- This Worker writes the same KV key on a 30-minute cron, about 48 writes per day, which is well below the same-key write rate and daily write count.
