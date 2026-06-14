import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

test("add, match, random get, and delete history content", async () => {
  const env = createEnv();

  let response = await fetchWorker(env, "/add", {
    method: "POST",
    body: { id: "0123456789abcdef", content: "hello history" },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    ok: true,
    id: "0123456789ABCDEF",
    inserted: 1,
  });

  response = await fetchWorker(env, "/add", {
    method: "POST",
    body: { id: "0123456789ABCDEF", content: "duplicate" },
  });
  assert.equal(response.status, 409);

  response = await fetchWorker(env, "/match", {
    method: "POST",
    body: {
      key: ["0123456789ABCDEF", "hello history", "FFFFFFFFFFFFFFFF", "miss"],
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    data: {
      "0123456789ABCDEF": "hello history",
      "hello history": "0123456789ABCDEF",
    },
    all_succeed: false,
    failed: ["miss"],
  });

  response = await worker.fetch(new Request("https://example.com/get"), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    "0123456789ABCDEF": "hello history",
  });

  response = await fetchWorker(env, "/delete", {
    method: "POST",
    body: { id: "0123456789ABCDEF" },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deleted, 1);

  response = await fetchWorker(env, "/match", {
    method: "POST",
    body: { key: ["0123456789ABCDEF"] },
  });
  assert.equal(response.status, 404);
});

test("rejects invalid auth and payloads", async () => {
  const env = createEnv();

  let response = await worker.fetch(
    jsonRequest("/add", {
      method: "POST",
      body: { id: "FFFFFFFFFFFFFFFF", content: "reserved" },
      token: "wrong",
    }),
    env,
  );
  assert.equal(response.status, 401);

  response = await fetchWorker(env, "/add", {
    method: "POST",
    body: { id: "FFFFFFFFFFFFFFFF", content: "reserved" },
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "reserved_id");

  response = await fetchWorker(env, "/add", {
    method: "POST",
    body: { id: "0123456789ABCDEF", content: "0123456789ABCDEF" },
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "content_must_not_be_16_hex");

  response = await fetchWorker(env, "/match", {
    method: "POST",
    body: { key: ["a", "b"] },
    vars: { MAX_BATCH_SIZE: "1" },
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_key_count");
});

test("match returns all_succeed true when every key resolves", async () => {
  const env = createEnv();
  await seedHistory(env, [
    ["AAAAAAAAAAAAAAAA", "alpha"],
    ["BBBBBBBBBBBBBBBB", "beta"],
  ]);

  const response = await fetchWorker(env, "/match", {
    method: "POST",
    body: { key: ["AAAAAAAAAAAAAAAA", "beta"] },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    data: {
      AAAAAAAAAAAAAAAA: "alpha",
      beta: "BBBBBBBBBBBBBBBB",
    },
    all_succeed: true,
    failed: [],
  });
});

test("match returns 404 when no key can be resolved", async () => {
  const env = createEnv();

  const response = await fetchWorker(env, "/match", {
    method: "POST",
    body: { key: ["AAAAAAAAAAAAAAAA", "missing content"] },
  });

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    data: {},
    all_succeed: false,
    failed: ["AAAAAAAAAAAAAAAA", "missing content"],
  });
});

test("reserved match id resolves to a real random id", async () => {
  const env = createEnv();
  await seedHistory(env, [["CCCCCCCCCCCCCCCC", "random value"]]);

  const response = await fetchWorker(env, "/match", {
    method: "POST",
    body: { key: ["FFFFFFFFFFFFFFFF"] },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    data: {
      CCCCCCCCCCCCCCCC: "random value",
    },
    all_succeed: true,
    failed: [],
  });
});

test("get returns cached KV data or rebuilds it from D1 on miss", async () => {
  const env = createEnv();
  await env.kv_public_get.put(
    "random_history",
    JSON.stringify({ CACHED0000000000: "cached content" }),
  );

  let response = await worker.fetch(new Request("https://example.com/get"), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    CACHED0000000000: "cached content",
  });

  const fallbackEnv = createEnv({ PUBLIC_RANDOM_SIZE: "1" });
  await seedHistory(fallbackEnv, [
    ["DDDDDDDDDDDDDDDD", "first public"],
    ["EEEEEEEEEEEEEEEE", "second public"],
  ]);

  response = await worker.fetch(new Request("https://example.com/get"), fallbackEnv);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(Object.keys(body).length, 1);
  assert.ok(
    body.DDDDDDDDDDDDDDDD === "first public" ||
      body.EEEEEEEEEEEEEEEE === "second public",
  );
  assert.deepEqual(await fallbackEnv.kv_public_get.get("random_history", "json"), body);
});

test("scheduled refresh writes public random content to KV", async () => {
  const env = createEnv({ PUBLIC_RANDOM_KV_KEY: "scheduled_random" });
  await seedHistory(env, [["1111111111111111", "scheduled content"]]);
  const promises = [];

  await worker.scheduled({}, env, {
    waitUntil(promise) {
      promises.push(promise);
    },
  });
  await Promise.all(promises);

  assert.deepEqual(await env.kv_public_get.get("scheduled_random", "json"), {
    "1111111111111111": "scheduled content",
  });
});

test("public random rebuild stays under the default Free plan D1 query budget", async () => {
  const env = createEnv({ PUBLIC_RANDOM_SIZE: "128" });
  await seedHistory(env, [["1111111111111111", "only row"]]);
  const queriesBeforeGet = env.HISTORY_DB.queryCount;

  const response = await worker.fetch(new Request("https://example.com/get"), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    "1111111111111111": "only row",
  });
  assert.ok(env.HISTORY_DB.queryCount - queriesBeforeGet <= 1);
});

test("public random rebuild can return 128 entries", async () => {
  const env = createEnv({ PUBLIC_RANDOM_SIZE: "128" });
  const entries = Array.from({ length: 150 }, (_, index) => [
    index.toString(16).padStart(16, "0").toUpperCase(),
    `history content ${index}`,
  ]);
  await seedHistory(env, entries);
  const queriesBeforeGet = env.HISTORY_DB.queryCount;

  const response = await worker.fetch(new Request("https://example.com/get"), env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(Object.keys(body).length, 128);
  assert.ok(env.HISTORY_DB.queryCount - queriesBeforeGet <= 1);
  assert.deepEqual(await env.kv_public_get.get("random_history", "json"), body);
});

test("add accepts upstream field aliases and delete accepts content_id", async () => {
  const env = createEnv();

  let response = await fetchWorker(env, "/add", {
    method: "POST",
    body: {
      new_content_id: "ABCDEFABCDEFABCD",
      new_content: "alias content",
    },
  });
  assert.equal(response.status, 201);

  response = await fetchWorker(env, "/delete", {
    method: "POST",
    body: { content_id: "ABCDEFABCDEFABCD" },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deleted, 1);
});

test("add prunes the oldest history row when the row cap is reached", async () => {
  const env = createEnv({ MAX_HISTORY_ROWS: "2" });

  await seedHistory(env, [
    ["0000000000000001", "oldest"],
    ["0000000000000002", "middle"],
  ]);

  const response = await fetchWorker(env, "/add", {
    method: "POST",
    body: { id: "0000000000000003", content: "newest" },
  });
  assert.equal(response.status, 201);

  let match = await fetchWorker(env, "/match", {
    method: "POST",
    body: { key: ["0000000000000001"] },
  });
  assert.equal(match.status, 404);

  match = await fetchWorker(env, "/match", {
    method: "POST",
    body: { key: ["0000000000000002", "0000000000000003"] },
  });
  assert.equal(match.status, 200);
  assert.deepEqual((await match.json()).data, {
    "0000000000000002": "middle",
    "0000000000000003": "newest",
  });
});

test("serializes D1 bigint metadata in delete JSON responses", async () => {
  const env = createEnv({ HISTORY_DB: createD1({ useBigIntMeta: true }) });

  let response = await fetchWorker(env, "/add", {
    method: "POST",
    body: { id: "2222222222222222", content: "bigint metadata" },
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    ok: true,
    id: "2222222222222222",
    inserted: 1,
  });

  response = await fetchWorker(env, "/delete", {
    method: "POST",
    body: { id: "2222222222222222" },
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).meta.last_row_id, "1");
});

test("delete reports missing and invalid ids", async () => {
  const env = createEnv();

  let response = await fetchWorker(env, "/delete", {
    method: "POST",
    body: { id: "9999999999999999" },
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "id_not_found");

  response = await fetchWorker(env, "/delete", {
    method: "POST",
    body: { id: "FFFFFFFFFFFFFFFF" },
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "reserved_id");
});

test("common HTTP validation branches return expected status codes", async () => {
  const env = createEnv();

  let response = await worker.fetch(new Request("https://example.com/unknown"), env);
  assert.equal(response.status, 404);

  response = await worker.fetch(new Request("https://example.com/match"), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");

  response = await worker.fetch(
    new Request("https://example.com/match", { method: "OPTIONS" }),
    env,
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");

  response = await worker.fetch(
    new Request("https://example.com/add", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify({ id: "0123456789ABCDEF", content: "missing type" }),
    }),
    env,
  );
  assert.equal(response.status, 415);

  response = await worker.fetch(
    new Request("https://example.com/add", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: "{",
    }),
    env,
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_json");

  response = await worker.fetch(
    jsonRequest("/add", {
      method: "POST",
      body: { id: "0123456789ABCDEF", content: "server token missing" },
    }),
    { ...env, API_TOKEN: "" },
  );
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, "server_missing_api_token");
});

test("payload validators reject malformed match and add payloads", async () => {
  const env = createEnv({ MAX_CONTENT_LENGTH: "4" });

  const cases = [
    ["/match", { key: [] }, "invalid_key_count"],
    ["/match", { key: [123] }, "key_item_must_be_string"],
    ["/match", { key: ["   "] }, "key_item_must_not_be_empty"],
    ["/match", { key: ["abcde"] }, "key_content_too_long"],
    ["/add", { id: "not-hex", content: "ok" }, "id_must_be_16_hex"],
    ["/add", { id: "0123456789ABCDEF", content: 123 }, "content_must_be_string"],
    ["/add", { id: "0123456789ABCDEF", content: "   " }, "content_must_not_be_empty"],
    ["/add", { id: "0123456789ABCDEF", content: "abcde" }, "content_too_long"],
  ];

  for (const [path, body, error] of cases) {
    const response = await fetchWorker(env, path, { method: "POST", body });
    assert.equal(response.status, 400, `${path} should reject ${error}`);
    assert.equal((await response.json()).error, error);
  }
});

test("match rejects payloads that would exceed the D1 query budget", async () => {
  const env = createEnv({ MAX_BATCH_SIZE: "50", D1_QUERY_BUDGET: "3" });

  const response = await fetchWorker(env, "/match", {
    method: "POST",
    body: { key: ["FFFFFFFFFFFFFFFF", "FFFFFFFFFFFFFFFF"] },
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "estimated_d1_query_budget_exceeded");
});

function createEnv(overrides = {}) {
  return {
    API_TOKEN: "test-token",
    MAX_BATCH_SIZE: "50",
    MAX_CONTENT_LENGTH: "2000",
    PUBLIC_RANDOM_SIZE: "128",
    PUBLIC_RANDOM_KV_KEY: "random_history",
    MAX_HISTORY_ROWS: "50000",
    HISTORY_DB: createD1(),
    kv_public_get: createKv(),
    ...overrides,
  };
}

async function seedHistory(env, entries) {
  for (const [id, content] of entries) {
    const response = await fetchWorker(env, "/add", {
      method: "POST",
      body: { id, content },
    });
    assert.equal(response.status, 201);
  }
}

function fetchWorker(env, path, options) {
  return worker.fetch(jsonRequest(path, options), {
    ...env,
    ...(options.vars ?? {}),
  });
}

function jsonRequest(path, { method, body, token = "test-token" }) {
  return new Request(`https://example.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function createKv() {
  const records = new Map();
  return {
    async get(key, type) {
      const value = records.get(key) ?? null;
      if (type === "json" && value !== null) {
        return JSON.parse(value);
      }
      return value;
    },
    async put(key, value) {
      records.set(key, value);
    },
  };
}

function createD1(options = {}) {
  const records = new Map();
  let queryCount = 0;
  let insertSequence = 0;
  const meta = (changes) => ({
    changes,
    ...(options.useBigIntMeta ? { last_row_id: 1n } : {}),
  });

  return {
    get queryCount() {
      return queryCount;
    },
    prepare(sql) {
      const statement = {
        params: [],
        bind(...params) {
          statement.params = params;
          return statement;
        },
        async first() {
          queryCount++;
          if (sql.includes("WHERE id = ?")) {
            const row = records.get(statement.params[0]);
            return row ? { ...row } : null;
          }

          if (sql.includes("COUNT(*) AS count")) {
            return { count: records.size };
          }

          if (sql.includes("WHERE id >= ?")) {
            const id = statement.params[0];
            const row = [...records.values()]
              .sort((left, right) => left.id.localeCompare(right.id))
              .find((candidate) => candidate.id >= id);
            return row ? { ...row } : null;
          }

          if (sql.includes("WHERE content = ?")) {
            const row = [...records.values()].find(
              (candidate) => candidate.content === statement.params[0],
            );
            return row ? { id: row.id } : null;
          }

          if (sql.includes("ORDER BY id ASC LIMIT 1")) {
            const row = [...records.values()].sort((left, right) =>
              left.id.localeCompare(right.id),
            )[0];
            return row ? { ...row } : null;
          }

          throw new Error(`Unsupported first SQL: ${sql}`);
        },
        async all() {
          queryCount++;
          const sortedRows = [...records.values()].sort((left, right) =>
            left.id.localeCompare(right.id),
          );

          if (sql.includes("ORDER BY RANDOM() LIMIT ?")) {
            const [limit] = statement.params;
            return {
              results: sortedRows.slice(0, limit).map((row) => ({ ...row })),
            };
          }

          throw new Error(`Unsupported all SQL: ${sql}`);
        },
        async run() {
          queryCount++;
          if (sql.includes("INSERT INTO history")) {
            const [id, content, createdAt, updatedAt] = statement.params;
            assert.equal(typeof createdAt, "number");
            assert.equal(typeof updatedAt, "number");
            insertSequence++;
            records.set(id, {
              id,
              content,
              created_at: createdAt + insertSequence,
              updated_at: updatedAt + insertSequence,
            });
            return { success: true, meta: meta(1) };
          }

          if (sql.includes("DELETE FROM history WHERE id = ?")) {
            const deleted = records.delete(statement.params[0]) ? 1 : 0;
            return { success: true, meta: meta(deleted) };
          }

          if (sql.includes("DELETE FROM history WHERE id IN")) {
            const [limit] = statement.params;
            const ids = [...records.values()]
              .sort(
                (left, right) =>
                  left.created_at - right.created_at || left.id.localeCompare(right.id),
              )
              .slice(0, limit)
              .map((row) => row.id);

            for (const id of ids) {
              records.delete(id);
            }

            return { success: true, meta: meta(ids.length) };
          }

          throw new Error(`Unsupported run SQL: ${sql}`);
        },
      };

      return statement;
    },
  };
}
