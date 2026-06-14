const HEX_16_RE = /^[0-9a-fA-F]{16}$/;
const RESERVED_ID = "FFFFFFFFFFFFFFFF";
const DEFAULT_MAX_BATCH_SIZE = 25;
const DEFAULT_MAX_CONTENT_LENGTH = 2000;
const DEFAULT_PUBLIC_RANDOM_SIZE = 128;
const DEFAULT_PUBLIC_RANDOM_KV_KEY = "random_history";
const DEFAULT_D1_QUERY_BUDGET = 45;
const DEFAULT_MAX_HISTORY_ROWS = 100000;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/match") {
        return await handleMatch(request, env);
      }

      if (url.pathname === "/get") {
        return await handleGet(request, env);
      }

      if (url.pathname === "/add") {
        return await handleAdd(request, env);
      }

      if (url.pathname === "/delete") {
        return await handleDelete(request, env);
      }

      return json({ error: "not_found" }, 404);
    } catch (error) {
      console.error(error);
      return json({ error: "internal_error" }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshPublicRandomKv(env));
  },
};

async function handleMatch(request, env) {
  const methodError = requireMethod(request, "POST");
  if (methodError) return methodError;

  const authError = requireBearerToken(request, env);
  if (authError) return authError;

  const body = await readJson(request);
  if (!body.ok) return body.response;

  const validation = validateMatchPayload(body.value, env);
  if (!validation.ok) return validation.response;

  const result = {};
  const failed = [];

  for (const item of validation.keys) {
    if (isReservedId(item)) {
      const row = await getRandomRow(env);
      if (row) {
        result[row.id] = row.content;
      } else {
        failed.push(item);
      }
      continue;
    }

    if (HEX_16_RE.test(item)) {
      const row = await env.HISTORY_DB.prepare(
        "SELECT id, content FROM history WHERE id = ? LIMIT 1",
      )
        .bind(normalizeId(item))
        .first();

      if (row) {
        result[row.id] = row.content;
      } else {
        failed.push(item);
      }
      continue;
    }

    const row = await env.HISTORY_DB.prepare(
      "SELECT id FROM history WHERE content = ? ORDER BY created_at ASC LIMIT 1",
    )
      .bind(item)
      .first();

    if (row) {
      result[item] = row.id;
    } else {
      failed.push(item);
    }
  }

  if (Object.keys(result).length === 0) {
    return json(
      {
        data: {},
        all_succeed: false,
        failed,
      },
      404,
    );
  }

  return json({
    data: result,
    all_succeed: failed.length === 0,
    failed,
  });
}

async function handleGet(request, env) {
  const methodError = requireMethod(request, "GET");
  if (methodError) return methodError;

  const key = getPublicRandomKvKey(env);
  const cached = await env.kv_public_get.get(key, "json");
  if (cached && typeof cached === "object" && !Array.isArray(cached)) {
    return json(cached);
  }

  const data = await buildPublicRandomMap(env);
  if (Object.keys(data).length > 0) {
    await env.kv_public_get.put(key, JSON.stringify(data));
  }

  return json(data);
}

async function handleAdd(request, env) {
  const methodError = requireMethod(request, "POST");
  if (methodError) return methodError;

  const authError = requireBearerToken(request, env);
  if (authError) return authError;

  const body = await readJson(request);
  if (!body.ok) return body.response;

  const validation = validateAddPayload(body.value, env);
  if (!validation.ok) return validation.response;

  try {
    const existing = await env.HISTORY_DB.prepare(
      "SELECT id FROM history WHERE id = ? LIMIT 1",
    )
      .bind(validation.id)
      .first();

    if (existing) {
      return json({ error: "duplicate_id", id: validation.id }, 409);
    }

    await pruneOldestHistoryIfNeeded(env);

    const now = Math.floor(Date.now() / 1000);
    await env.HISTORY_DB.prepare(
      "INSERT INTO history (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
      .bind(validation.id, validation.content, now, now)
      .run();
  } catch (error) {
    console.error(error);
    return json(
      {
        error: "database_write_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }

  return json({ ok: true, id: validation.id, inserted: 1 }, 201);
}

async function pruneOldestHistoryIfNeeded(env) {
  const maxRows = getMaxHistoryRows(env);
  if (maxRows <= 0) return;

  const row = await env.HISTORY_DB.prepare(
    "SELECT COUNT(*) AS count FROM history",
  ).first();
  const count = Number(row?.count ?? 0);
  if (count < maxRows) return;

  await env.HISTORY_DB.prepare(
    "DELETE FROM history WHERE id IN (SELECT id FROM history ORDER BY created_at ASC, id ASC LIMIT ?)",
  )
    .bind(count - maxRows + 1)
    .run();
}

async function handleDelete(request, env) {
  const methodError = requireMethod(request, "POST");
  if (methodError) return methodError;

  const authError = requireBearerToken(request, env);
  if (authError) return authError;

  const body = await readJson(request);
  if (!body.ok) return body.response;

  const validation = validateDeletePayload(body.value);
  if (!validation.ok) return validation.response;

  const result = await env.HISTORY_DB.prepare("DELETE FROM history WHERE id = ?")
    .bind(validation.id)
    .run();
  const deleted = result.meta?.changes ?? 0;

  if (deleted === 0) {
    return json({ error: "id_not_found", id: validation.id, deleted: 0 }, 404);
  }

  return json({
    ok: result.success,
    id: validation.id,
    deleted,
    meta: result.meta,
  });
}

async function refreshPublicRandomKv(env) {
  const data = await buildPublicRandomMap(env);
  await env.kv_public_get.put(getPublicRandomKvKey(env), JSON.stringify(data));
}

async function buildPublicRandomMap(env) {
  const limit = getPositiveInteger(
    env.PUBLIC_RANDOM_SIZE,
    DEFAULT_PUBLIC_RANDOM_SIZE,
    1,
    128,
  );
  const rows = new Map();

  for (const row of await getRandomRows(env, limit)) {
    rows.set(row.id, row.content);
  }

  return Object.fromEntries(rows);
}

async function getRandomRows(env, limit) {
  const result = await env.HISTORY_DB.prepare(
    "SELECT id, content FROM history ORDER BY RANDOM() LIMIT ?",
  )
    .bind(limit)
    .all();
  return result.results ?? [];
}

async function getRandomRow(env) {
  const randomId = createRandomId();
  const row = await env.HISTORY_DB.prepare(
    "SELECT id, content FROM history WHERE id >= ? ORDER BY id ASC LIMIT 1",
  )
    .bind(randomId)
    .first();

  if (row) return row;

  return await env.HISTORY_DB.prepare(
    "SELECT id, content FROM history ORDER BY id ASC LIMIT 1",
  ).first();
}

function validateMatchPayload(payload, env) {
  if (!isPlainObject(payload)) {
    return invalid("payload_must_be_object");
  }

  if (!Array.isArray(payload.key)) {
    return invalid("key_must_be_list");
  }

  const maxBatchSize = getPositiveInteger(
    env.MAX_BATCH_SIZE,
    DEFAULT_MAX_BATCH_SIZE,
    1,
    500,
  );
  if (payload.key.length === 0 || payload.key.length > maxBatchSize) {
    return invalid("invalid_key_count", { max_batch_size: maxBatchSize });
  }

  const maxContentLength = getMaxContentLength(env);
  const keys = [];
  let estimatedD1Queries = 0;
  for (const item of payload.key) {
    if (typeof item !== "string") {
      return invalid("key_item_must_be_string");
    }

    const key = item.trim();
    if (key.length === 0) {
      return invalid("key_item_must_not_be_empty");
    }

    if (!HEX_16_RE.test(key) && key.length > maxContentLength) {
      return invalid("key_content_too_long", {
        max_content_length: maxContentLength,
      });
    }

    keys.push(key);
    estimatedD1Queries += isReservedId(key) ? 2 : 1;
  }

  const d1QueryBudget = getPositiveInteger(
    env.D1_QUERY_BUDGET,
    DEFAULT_D1_QUERY_BUDGET,
    1,
    50,
  );
  if (estimatedD1Queries > d1QueryBudget) {
    return invalid("estimated_d1_query_budget_exceeded", {
      d1_query_budget: d1QueryBudget,
    });
  }

  return { ok: true, keys };
}

function validateAddPayload(payload, env) {
  if (!isPlainObject(payload)) {
    return invalid("payload_must_be_object");
  }

  const id = payload.id ?? payload.content_id ?? payload.new_content_id;
  const content = payload.content ?? payload.new_content;

  if (typeof id !== "string" || !HEX_16_RE.test(id)) {
    return invalid("id_must_be_16_hex");
  }

  const normalizedId = normalizeId(id);
  if (isReservedId(normalizedId)) {
    return invalid("reserved_id");
  }

  if (typeof content !== "string") {
    return invalid("content_must_be_string");
  }

  const normalizedContent = content.trim();
  if (normalizedContent.length === 0) {
    return invalid("content_must_not_be_empty");
  }

  if (normalizedContent.length > getMaxContentLength(env)) {
    return invalid("content_too_long", {
      max_content_length: getMaxContentLength(env),
    });
  }

  if (HEX_16_RE.test(normalizedContent)) {
    return invalid("content_must_not_be_16_hex");
  }

  return { ok: true, id: normalizedId, content: normalizedContent };
}

function validateDeletePayload(payload) {
  if (!isPlainObject(payload)) {
    return invalid("payload_must_be_object");
  }

  const id = payload.id ?? payload.content_id;
  if (typeof id !== "string" || !HEX_16_RE.test(id)) {
    return invalid("id_must_be_16_hex");
  }

  const normalizedId = normalizeId(id);
  if (isReservedId(normalizedId)) {
    return invalid("reserved_id");
  }

  return { ok: true, id: normalizedId };
}

function requireMethod(request, method) {
  if (request.method !== method) {
    return json({ error: "method_not_allowed", allow: method }, 405, {
      Allow: method,
    });
  }

  return null;
}

function requireBearerToken(request, env) {
  if (!env.API_TOKEN) {
    return json({ error: "server_missing_api_token" }, 500);
  }

  const authorization = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${env.API_TOKEN}`;
  if (authorization !== expected) {
    return json({ error: "unauthorized" }, 401, {
      "WWW-Authenticate": 'Bearer realm="na-hitokoto-history"',
    });
  }

  return null;
}

async function readJson(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      response: json({ error: "content_type_must_be_application_json" }, 415),
    };
  }

  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, response: json({ error: "invalid_json" }, 400) };
  }
}

function invalid(error, details = {}) {
  return {
    ok: false,
    response: json({ error, ...details }, 400),
  };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body, jsonReplacer), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...headers,
    },
  });
}

function jsonReplacer(_key, value) {
  if (typeof value === "bigint") {
    return value.toString();
  }

  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeId(id) {
  return id.toUpperCase();
}

function isReservedId(id) {
  return normalizeId(id) === RESERVED_ID;
}

function getMaxContentLength(env) {
  return getPositiveInteger(
    env.MAX_CONTENT_LENGTH,
    DEFAULT_MAX_CONTENT_LENGTH,
    1,
    10000,
  );
}

function getPublicRandomKvKey(env) {
  return env.PUBLIC_RANDOM_KV_KEY || DEFAULT_PUBLIC_RANDOM_KV_KEY;
}

function getMaxHistoryRows(env) {
  return getPositiveInteger(
    env.MAX_HISTORY_ROWS,
    DEFAULT_MAX_HISTORY_ROWS,
    0,
    1000000,
  );
}

function createRandomId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function getPositiveInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}
