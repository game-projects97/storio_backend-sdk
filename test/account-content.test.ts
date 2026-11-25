import assert from "node:assert/strict";
import { test } from "node:test";
import { PlatformClient, PlatformError } from "@storio/platform-sdk";

const options = {
  baseUrl: "/api/v1",
  projectId: "project-one",
  environment: "development" as const,
  clientVersion: "1.2.3",
};
const credentials = { custom_id: "player_one", password: "test-password" };
const customSession = {
  player_id: "player-old",
  kind: "custom",
  token: "custom-token",
  token_type: "Bearer",
  expires_at: 4_000_000_000,
};
const link = {
  player_id: "player-old",
  kind: "custom",
  custom_id: "player_one",
};
const saved = {
  version: 6,
  progress: { schema_version: 1, stage: 9, intro_seen: true },
};
const policy = {
  project_id: "project-one",
  environment: "development",
  policy_revision: 1,
  maintenance_active: false,
  maintenance_message: "",
  version_status: "supported",
  minimum_version: "1.2.3",
  recommended_version: "1.2.3",
  update_url: "",
};
const chart = {
  id: "chart-one",
  kind: "chart",
  key: "battle-rules",
  locale: "en",
  revision: 2,
  publication_version: 3,
  body: {
    columns: [
      { name: "label", type: "string" },
      { name: "cost", type: "number" },
      { name: "active", type: "boolean" },
    ],
    rows: [{ label: "recruit", cost: 12.5, active: true }],
  },
};
const notice = {
  id: "notice-one",
  kind: "notice",
  key: "welcome",
  locale: "en",
  revision: 4,
  publication_version: 5,
  body: { title: "Welcome", body: "Hello." },
};

test("custom signup and login apply the new session only after a valid response", async (t) => {
  const signupRequested = Promise.withResolvers<void>();
  const signup = Promise.withResolvers<Response>();
  const auth: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    const bearer = new Headers(init.headers).get("Authorization");
    if (url === "/api/v1/game/project-one/development/accounts/custom") {
      assert.equal(init.method, "POST");
      assert.equal(bearer, null);
      assert.deepEqual(JSON.parse(String(init.body)), credentials);
      signupRequested.resolve();
      return signup.promise;
    }
    if (url === "/api/v1/game/project-one/development/sessions/custom") {
      assert.equal(init.method, "POST");
      assert.equal(bearer, null);
      assert.deepEqual(JSON.parse(String(init.body)), credentials);
      return Response.json({ ...customSession, token: "login-token" });
    }
    assert.ok(url.endsWith("/game/progress"));
    auth.push(bearer);
    return Response.json(saved);
  });
  const client = new PlatformClient(options);
  t.after(() => client.close());
  client.setSession("previous");
  const pending = client.signupCustom(credentials);
  await signupRequested.promise;
  await client.readProgress();
  signup.resolve(Response.json(customSession, { status: 201 }));
  assert.deepEqual(await pending, customSession);
  await client.readProgress();
  assert.equal((await client.loginCustom(credentials)).player_id, "player-old");
  await client.readProgress();
  assert.deepEqual(auth, [
    "Bearer previous",
    "Bearer custom-token",
    "Bearer login-token",
  ]);
});

test("an older custom login cannot win after a newer account selection", async (t) => {
  const oldRequest = Promise.withResolvers<Response>();
  const newRequest = Promise.withResolvers<Response>();
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/sessions/custom")) {
      requests += 1;
      return requests === 1 ? oldRequest.promise : newRequest.promise;
    }
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      "Bearer chosen",
    );
    return Response.json(saved);
  });
  const client = new PlatformClient(options);
  t.after(() => client.close());
  const oldLogin = client.loginCustom(credentials);
  const newLogin = client.loginCustom({ ...credentials, custom_id: "second" });
  oldRequest.resolve(Response.json(customSession));
  await assert.rejects(oldLogin, { name: "AbortError" });
  newRequest.resolve(Response.json({ ...customSession, token: "chosen" }));
  assert.equal((await newLogin).token, "chosen");
  await client.readProgress();
});

test("failed or canceled custom authentication keeps the current session", async (t) => {
  const aborted = new AbortController();
  let signupCalls = 0;
  let logins = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/accounts/custom")) {
      signupCalls += 1;
      return Response.json({ code: "custom_id_taken" }, { status: 409 });
    }
    if (url.endsWith("/sessions/custom")) {
      logins += 1;
      const response = Response.json(customSession);
      response.json = async () => {
        queueMicrotask(() => queueMicrotask(() => aborted.abort()));
        return customSession;
      };
      return response;
    }
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      "Bearer previous",
    );
    return Response.json(saved);
  });
  const client = new PlatformClient(options);
  t.after(() => client.close());
  client.setSession("previous");
  await assert.rejects(client.signupCustom(credentials, AbortSignal.abort()), {
    name: "AbortError",
  });
  assert.equal(signupCalls, 0);
  await assert.rejects(
    client.signupCustom(credentials),
    (error: unknown) => error instanceof PlatformError && error.status === 409,
  );
  await assert.rejects(client.loginCustom(credentials, aborted.signal), {
    name: "AbortError",
  });
  assert.equal(logins, 1);
  assert.equal((await client.readProgress()).version, 6);
});

test("link response loss is returned and explicit replay keeps the original player and progress", async (t) => {
  const responseLost = new TypeError("connection closed after commit");
  let linkRequests = 0;
  let savedLink: typeof credentials | undefined;
  const bearerHistory: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const bearer = new Headers(init.headers).get("Authorization");
    if (url === "/api/v1/game/account/custom") {
      linkRequests += 1;
      assert.equal(init.method, "POST");
      assert.equal(bearer, "Bearer guest-token");
      const sent: typeof credentials = JSON.parse(String(init.body));
      assert.deepEqual(sent, credentials);
      if (!savedLink) {
        savedLink = sent;
        throw responseLost;
      }
      assert.deepEqual(sent, savedLink);
      return Response.json(link);
    }
    if (url.endsWith("/sessions/custom")) {
      assert.deepEqual(JSON.parse(String(init.body)), savedLink);
      return Response.json(customSession);
    }
    assert.ok(url.endsWith("/game/progress"));
    bearerHistory.push(bearer);
    return Response.json(saved);
  });
  const client = new PlatformClient(options);
  t.after(() => client.close());
  const originalPlayerId = "player-old";
  client.setSession("guest-token");
  await assert.rejects(
    client.linkGuestToCustom(credentials),
    (error: unknown) => error === responseLost,
  );
  assert.equal(linkRequests, 1);
  assert.deepEqual(await client.readProgress(), saved);
  const linked = await client.linkGuestToCustom(credentials);
  assert.equal(linked.player_id, originalPlayerId);
  assert.equal(linked.kind, "custom");
  assert.equal(linked.custom_id, credentials.custom_id);
  assert.deepEqual(await client.readProgress(), saved);
  assert.equal(
    (await client.loginCustom(credentials)).player_id,
    originalPlayerId,
  );
  assert.deepEqual(await client.readProgress(), saved);
  assert.deepEqual(bearerHistory, [
    "Bearer guest-token",
    "Bearer guest-token",
    "Bearer custom-token",
  ]);
  assert.equal(linkRequests, 2);
});

test("link rejects an authentication error without clearing an otherwise valid session", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      "Bearer guest-token",
    );
    return url.endsWith("/game/account/custom")
      ? Response.json({ code: "unauthorized" }, { status: 401 })
      : Response.json(saved);
  });
  const client = new PlatformClient(options);
  t.after(() => client.close());
  client.setSession("guest-token");
  await assert.rejects(
    client.linkGuestToCustom(credentials),
    (error: unknown) => error instanceof PlatformError && error.status === 401,
  );
  assert.equal((await client.readProgress()).version, 6);
});

test("published notices and charts return the actual locale and forward pagination options", async (t) => {
  const cursor = "123e4567-e89b-42d3-a456-426614174004";
  const noticeCursor = "123e4567-e89b-42d3-a456-426614174005";
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      "Bearer active",
    );
    assert.equal(init.cache, undefined);
    const parsed = new URL(url, "https://example.com");
    assert.equal(
      parsed.search,
      `?locale=ko-KR&fallback_locale=en&cursor=${cursor}`,
    );
    if (parsed.pathname.endsWith("/notice")) {
      return Response.json({
        items: [{ ...notice, id: noticeCursor }],
        next_cursor: noticeCursor,
      });
    }
    assert.ok(parsed.pathname.endsWith("/chart"));
    return Response.json({ items: [chart], next_cursor: null });
  });
  const client = new PlatformClient(options);
  t.after(() => client.close());
  client.setSession("active");
  const query = { locale: "ko-KR", fallbackLocale: "en", cursor };
  assert.deepEqual(await client.readPublishedNotices(query), {
    items: [{ ...notice, id: noticeCursor }],
    next_cursor: noticeCursor,
  });
  assert.deepEqual(await client.readPublishedCharts(query), {
    items: [chart],
    next_cursor: null,
  });
});

test("published lists reject empty and invalid continuation cursors", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) =>
    Response.json(
      url.endsWith("/chart")
        ? { items: [chart], next_cursor: "" }
        : { items: [notice], next_cursor: "not-a-uuid" },
    ),
  );
  const client = new PlatformClient(options);
  t.after(() => client.close());
  client.setSession("active");
  await assert.rejects(client.readPublishedCharts(), /invalid_response/);
  await assert.rejects(client.readPublishedNotices(), /invalid_response/);
});

test("shape validation rejects malformed bootstrap, account and published content payloads", async (t) => {
  let body: unknown;
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  const client = new PlatformClient(options);
  t.after(() => client.close());
  client.setSession("active");
  const malformed: [unknown, () => Promise<unknown>][] = [
    [{ ...policy, version_status: "obsolete" }, () => client.bootstrap()],
    [{ ...policy, project_id: "other" }, () => client.bootstrap()],
    [{ ...policy, maintenance_message: null }, () => client.bootstrap()],
    [
      { ...customSession, kind: "guest" },
      () => client.signupCustom(credentials),
    ],
    [
      { ...customSession, token_type: "Cookie" },
      () => client.loginCustom(credentials),
    ],
    [
      { ...link, custom_id: undefined },
      () => client.linkGuestToCustom(credentials),
    ],
    [{ items: [notice] }, () => client.readPublishedNotices()],
    [
      { items: [{ ...notice, body: { title: "No body" } }], next_cursor: null },
      () => client.readPublishedNotices(),
    ],
    [
      { items: [{ ...chart, publication_version: "3" }], next_cursor: null },
      () => client.readPublishedCharts(),
    ],
    [
      {
        items: [
          {
            ...chart,
            body: {
              ...chart.body,
              rows: [{ label: "recruit", cost: true, active: true }],
            },
          },
        ],
        next_cursor: null,
      },
      () => client.readPublishedCharts(),
    ],
    [
      {
        items: [
          {
            ...chart,
            body: {
              ...chart.body,
              columns: [{ name: "value", type: "object" }],
            },
          },
        ],
        next_cursor: null,
      },
      () => client.readPublishedCharts(),
    ],
  ];
  for (const [value, read] of malformed) {
    body = value;
    await assert.rejects(read, /invalid_response/);
  }
  body = saved;
  assert.equal((await client.readProgress()).version, 6);
});

test("published chart key reads one scoped page with ordinary browser caching", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls += 1;
    assert.equal(
      url,
      "/api/v1/game/content/chart?locale=ko-KR&fallback_locale=en&key=battle-rules",
    );
    assert.equal(init.cache, undefined);
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      "Bearer active",
    );
    assert.equal(new Headers(init.headers).get("If-None-Match"), null);
    return Response.json({
      items: calls === 1 ? [chart] : [],
      next_cursor: null,
    });
  });
  const client = new PlatformClient(options);
  t.after(() => client.close());
  client.setSession("active");
  const query = { locale: "ko-KR", fallbackLocale: "en", cursor: "ignored" };
  assert.deepEqual(
    await client.readPublishedChart("battle-rules", query),
    chart,
  );
  assert.equal(
    await client.readPublishedChart("battle-rules", query),
    undefined,
  );
  assert.equal(calls, 2);
});

test("published chart key lookup rejects invalid pages and another chart key", async (t) => {
  let body: unknown;
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  const client = new PlatformClient(options);
  t.after(() => client.close());
  client.setSession("active");
  for (const page of [
    { items: [chart, chart], next_cursor: null },
    { items: [chart], next_cursor: "123e4567-e89b-42d3-a456-426614174006" },
    { items: [{ ...chart, key: "other" }], next_cursor: null },
  ]) {
    body = page;
    await assert.rejects(
      client.readPublishedChart("battle-rules"),
      /invalid_response/,
    );
  }
});
