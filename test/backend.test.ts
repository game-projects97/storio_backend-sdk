import { test } from "node:test";
import assert from "node:assert/strict";
import { Backend, BackendError } from "backend-sdk";

const progress = { schema_version: 1 as const, stage: 12, intro_seen: true };
const save = { expected_version: 0, request_id: "test-request", progress };
const options = {
  baseUrl: "https://backend.example",
  projectId: "project-one",
  environment: "development" as const,
  clientVersion: "0.9.0",
  timeoutMs: 30,
};

test("guest, login, save, read and logout preserve the server contract", async (t) => {
  const calls: {
    url: string;
    method: string;
    bearer: string | null;
    body: string | undefined;
  }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(headers.get("X-Client-Version"), "0.9.0");
    calls.push({
      url,
      method: init.method!,
      bearer: headers.get("Authorization"),
      body: init.body as string,
    });
    if (url.endsWith("/guests"))
      return Response.json({ player_id: "one", credential: "secret" });
    if (url.endsWith("/sessions"))
      return Response.json({
        token: "token-one",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ version: 1, progress });
  });
  const backend = new Backend(options);
  t.after(() => backend.close());
  const credentials = await backend.createGuest();
  await backend.login(credentials);
  const saved = await backend.saveProgress(save);
  assert.equal(saved.version, 1);
  assert.equal((await backend.readProgress()).progress.stage, 12);
  await backend.logout();
  assert.equal(
    calls[0].url,
    "https://backend.example/api/v1/game/project-one/development/guests",
  );
  assert.equal(calls[2].bearer, "Bearer token-one");
  assert.equal(JSON.parse(calls[2].body!).request_id, "test-request");
  await assert.rejects(backend.readProgress(), /session_required/);
});

test("duplicate in-flight saves share one request; changed input is rejected", async (t) => {
  let finish!: (response: Response) => void;
  let count = 0;
  t.mock.method(globalThis, "fetch", () => {
    count += 1;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  const backend = new Backend({ ...options, timeoutMs: 1000 });
  backend.setSession("one");
  t.after(() => backend.close());
  const first = backend.saveProgress(save);
  const second = backend.saveProgress(structuredClone(save));
  await assert.rejects(
    backend.saveProgress({ ...save, expected_version: 3 }),
    /request_id_reused/,
  );
  assert.equal(count, 1);
  finish(Response.json({ version: 1, progress }));
  assert.equal((await first).version, 1);
  assert.equal((await second).version, 1);
});

test("switching account and closing reject delayed responses even if fetch ignores abort", async (t) => {
  const pending: ((response: Response) => void)[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    () => new Promise<Response>((resolve) => pending.push(resolve)),
  );
  const backend = new Backend({ ...options, timeoutMs: 1000 });
  backend.setSession("old");
  t.after(() => backend.close());
  const beforeSwitch = backend.readProgress();
  backend.setSession("new");
  pending.shift()!(Response.json({ version: 99, progress }));
  await assert.rejects(
    beforeSwitch,
    (error: Error) => error.name === "AbortError",
  );
  const beforeClose = backend.readProgress();
  backend.close();
  pending.shift()!(Response.json({ version: 99, progress }));
  await assert.rejects(
    beforeClose,
    (error: Error) => error.name === "AbortError",
  );
  await assert.rejects(backend.createGuest(), /client_closed/);
  assert.throws(() => backend.setSession("later"), /client_closed/);
});

test("deadline and caller cancellation reach fetch without retry", async (t) => {
  let count = 0;
  t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => {
    count += 1;
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener(
        "abort",
        () => reject(init.signal!.reason),
        { once: true },
      );
    });
  });
  const backend = new Backend(options);
  backend.setSession("one");
  t.after(() => backend.close());
  await assert.rejects(
    backend.readProgress(),
    (error: Error) => error.name === "TimeoutError",
  );
  const controller = new AbortController();
  const pending = backend.readProgress(controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
  controller.abort();
  await assert.rejects(
    backend.readProgress(controller.signal),
    (error: Error) => error.name === "AbortError",
  );
  assert.equal(count, 2);
});

test("conflict stays explicit without a read or overwrite retry", async (t) => {
  let count = 0;
  t.mock.method(globalThis, "fetch", async () => {
    count += 1;
    return Response.json({ code: "version_conflict" }, { status: 409 });
  });
  const backend = new Backend(options);
  backend.setSession("one");
  t.after(() => backend.close());
  await assert.rejects(
    backend.saveProgress(save),
    (error: unknown) =>
      error instanceof BackendError &&
      error.status === 409 &&
      error.code === "version_conflict",
  );
  assert.equal(count, 1);
});

test("refresh changes the token for subsequent requests", async (t) => {
  let lastBearer = "";
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    lastBearer = new Headers(init.headers).get("Authorization") ?? "";
    return url.endsWith("/refresh")
      ? Response.json({
          token: "rotated",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        })
      : Response.json({ version: 1, progress });
  });
  const backend = new Backend(options);
  backend.setSession("one");
  t.after(() => backend.close());
  await backend.refreshSession();
  await backend.readProgress();
  assert.equal(lastBearer, "Bearer rotated");
});

test("configuration rejects invalid timeouts and credential-bearing URLs", () => {
  for (const timeoutMs of [0, NaN, Infinity, -1]) {
    assert.throws(
      () => new Backend({ ...options, timeoutMs }),
      /timeout/,
    );
  }
  assert.throws(
    () =>
      new Backend({ ...options, baseUrl: "https://secret@example.com" }),
    /baseUrl/,
  );
});

test("bootstrap uses a same-origin browser path and sends no session", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(
      url,
      "/api/v1/game/project-one/development/bootstrap?client_version=1.0.0",
    );
    assert.equal(init.mode, "same-origin");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).has("Authorization"), false);
    return Response.json({
      project_id: "project-one",
      environment: "development",
      policy_revision: 2,
      maintenance_active: false,
      maintenance_message: "",
      version_status: "supported",
      minimum_version: "0.1.0",
      recommended_version: "1.0.0",
      update_url: "",
    });
  });
  const backend = new Backend({
    ...options,
    baseUrl: "/api/v1/",
    clientVersion: "1.0.0",
  });
  t.after(() => backend.close());
  backend.setSession("existing");
  assert.equal((await backend.bootstrap()).policy_revision, 2);
});

test("published charts preserve query parameters and use the active bearer", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(
      url,
      "https://backend.example/api/v1/game/content/chart?locale=ko-KR&fallback_locale=en&cursor=123e4567-e89b-42d3-a456-426614174000",
    );
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      "Bearer active",
    );
    return Response.json({
      items: [],
      next_cursor: "123e4567-e89b-42d3-a456-426614174001",
    });
  });
  const backend = new Backend(options);
  t.after(() => backend.close());
  backend.setSession("active");
  const result = await backend.readPublishedCharts({
    locale: "ko-KR",
    fallbackLocale: "en",
    cursor: "123e4567-e89b-42d3-a456-426614174000",
  });
  assert.equal(result.next_cursor, "123e4567-e89b-42d3-a456-426614174001");
});

test("malformed success JSON rejects without exposing response body text", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("<test-private-body>"),
  );
  const backend = new Backend(options);
  t.after(() => backend.close());
  await assert.rejects(
    backend.bootstrap(),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "invalid_response" &&
      error.cause === undefined,
  );
});

test("malformed refresh responses do not replace the current token", async (t) => {
  const responses = [
    { expires_at: 4_000_000_000 },
    { token: "replacement", expires_at: "4_000_000_000" },
  ];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      "Bearer existing",
    );
    if (url.endsWith("/session/refresh"))
      return Response.json(responses.shift());
    return Response.json({ version: 1, progress });
  });
  const backend = new Backend(options);
  t.after(() => backend.close());
  backend.setSession("existing");
  for (const response of [...responses]) {
    await assert.rejects(
      backend.refreshSession(),
      /invalid_response/,
      JSON.stringify(response),
    );
    assert.equal((await backend.readProgress()).version, 1);
  }
});

test("non-JSON HTTP failures retain status without success-shaped results", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("unavailable", { status: 503 }),
  );
  const backend = new Backend(options);
  backend.setSession("one");
  t.after(() => backend.close());
  await assert.rejects(
    backend.readProgress(),
    (error: unknown) =>
      error instanceof BackendError &&
      error.status === 503 &&
      error.code === "request_failed",
  );
});

test("a duplicate caller can cancel its wait without aborting the first save", async (t) => {
  let finish!: (response: Response) => void;
  t.mock.method(
    globalThis,
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const backend = new Backend({ ...options, timeoutMs: 1000 });
  backend.setSession("one");
  t.after(() => backend.close());
  const first = backend.saveProgress(save);
  const caller = new AbortController();
  const second = backend.saveProgress(save, caller.signal);
  caller.abort();
  await assert.rejects(second, (error: Error) => error.name === "AbortError");
  finish(Response.json({ version: 1, progress }));
  assert.equal((await first).version, 1);
});

test("an account switch between parsing and login completion keeps the new token", async (t) => {
  const backend = new Backend(options);
  t.after(() => backend.close());
  let bearer = "";
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/sessions")) {
      const response = Response.json({
        token: "late",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
      response.json = async () => {
        queueMicrotask(() => queueMicrotask(() => backend.setSession("new")));
        return {
          token: "late",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        };
      };
      return response;
    }
    bearer = new Headers(init.headers).get("Authorization") ?? "";
    return Response.json({ version: 1, progress });
  });
  await assert.rejects(
    backend.login({ player_id: "old", credential: "old" }),
    (error: Error) => error.name === "AbortError",
  );
  await backend.readProgress();
  assert.equal(bearer, "Bearer new");
});

test("a pre-aborted guest login leaves the active session and requests intact", async (t) => {
  const pending = Promise.withResolvers<Response>();
  const calls: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => {
    calls.push(new Headers(init.headers).get("Authorization"));
    return calls.length === 1
      ? pending.promise
      : Promise.resolve(Response.json({ version: 1, progress }));
  });
  const backend = new Backend(options);
  t.after(() => backend.close());
  backend.setSession("existing");
  const read = backend.readProgress();
  const login = backend.login(
    { player_id: "guest", credential: "secret" },
    AbortSignal.abort(),
  );
  pending.resolve(Response.json({ version: 1, progress }));
  await assert.rejects(login, { name: "AbortError" });
  assert.equal((await read).version, 1);
  await backend.readProgress();
  assert.deepEqual(calls, ["Bearer existing", "Bearer existing"]);
});

test("caller abort after parsing guest login prevents installing the response token", async (t) => {
  const caller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => {
    const session = { token: "late-guest", expires_at: 4_000_000_000 };
    const response = Response.json(session);
    response.json = async () => {
      queueMicrotask(() => queueMicrotask(() => caller.abort()));
      return session;
    };
    return response;
  });
  const backend = new Backend(options);
  t.after(() => backend.close());
  await assert.rejects(
    backend.login({ player_id: "guest", credential: "secret" }, caller.signal),
    { name: "AbortError" },
  );
  await assert.rejects(backend.readProgress(), /session_required/);
});

test("near-expiry requests and manual refresh share one rotation before sending", async (t) => {
  let finish!: (response: Response) => void;
  const calls: { url: string; bearer: string | null }[] = [];
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
    calls.push({ url, bearer: new Headers(init.headers).get("Authorization") });
    if (url.endsWith("/refresh"))
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    return Promise.resolve(Response.json({ version: 1, progress }));
  });
  const backend = new Backend({ ...options, timeoutMs: 1000 });
  t.after(() => backend.close());
  backend.setSession({ token: "old", expires_at: Date.now() / 1000 + 30 });
  const read = backend.readProgress();
  const write = backend.saveProgress(save);
  const refresh = backend.refreshSession();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bearer, "Bearer old");
  finish(Response.json({ token: "new", expires_at: Date.now() / 1000 + 3600 }));
  await Promise.all([read, write, refresh]);
  assert.equal(calls.length, 3);
  assert.ok(calls.slice(1).every((call) => call.bearer === "Bearer new"));
});

test("expired sessions cannot refresh or send mutations and require login", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({});
  });
  const backend = new Backend(options);
  t.after(() => backend.close());
  for (const operation of [
    () => backend.refreshSession(),
    () => backend.saveProgress(save),
  ]) {
    backend.setSession({ token: "expired", expires_at: Date.now() / 1000 - 1 });
    await assert.rejects(
      operation(),
      (error: unknown) =>
        error instanceof BackendError && error.code === "session_expired",
    );
    await assert.rejects(backend.readProgress(), /session_required/);
  }
  assert.equal(calls, 0);
});

test("401 clears current session without retrying or refreshing a mutation", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ code: "unauthorized" }, { status: 401 });
  });
  const backend = new Backend(options);
  t.after(() => backend.close());
  backend.setSession("revoked");
  await assert.rejects(
    backend.saveProgress(save),
    (error: unknown) => error instanceof BackendError && error.status === 401,
  );
  await assert.rejects(backend.refreshSession(), /session_required/);
  assert.equal(calls, 1);
});

test("canceling a refresh waiter does not cancel shared rotation", async (t) => {
  let finish!: (response: Response) => void;
  let transportSignal!: AbortSignal;
  let calls = 0;
  t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => {
    calls++;
    transportSignal = init.signal!;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  const backend = new Backend({ ...options, timeoutMs: 1000 });
  t.after(() => backend.close());
  backend.setSession("one");
  const controller = new AbortController();
  const first = backend.refreshSession(controller.signal);
  const second = backend.refreshSession();
  controller.abort();
  await assert.rejects(first, (error: Error) => error.name === "AbortError");
  assert.equal(transportSignal.aborted, false);
  finish(
    Response.json({ token: "rotated", expires_at: Date.now() / 1000 + 3600 }),
  );
  assert.equal((await second).token, "rotated");
  assert.equal(calls, 1);
});

test("account switch prevents delayed refresh from overwriting new account", async (t) => {
  let finish!: (response: Response) => void;
  let bearer = "";
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
    if (url.endsWith("/refresh"))
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    bearer = new Headers(init.headers).get("Authorization")!;
    return Promise.resolve(Response.json({ version: 1, progress }));
  });
  const backend = new Backend({ ...options, timeoutMs: 1000 });
  t.after(() => backend.close());
  backend.setSession("old-account");
  const refresh = backend.refreshSession();
  backend.setSession("new-account");
  finish(
    Response.json({
      token: "late-old-account",
      expires_at: Date.now() / 1000 + 3600,
    }),
  );
  await assert.rejects(refresh, (error: Error) => error.name === "AbortError");
  await backend.readProgress();
  assert.equal(bearer, "Bearer new-account");
});

test("late 401 for rotated token cannot clear new session", async (t) => {
  let finish!: (response: Response) => void;
  let reads = 0;
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
    if (url.endsWith("/refresh"))
      return Promise.resolve(
        Response.json({ token: "new", expires_at: Date.now() / 1000 + 3600 }),
      );
    if (++reads === 1)
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer new");
    return Promise.resolve(Response.json({ version: 1, progress }));
  });
  const backend = new Backend({ ...options, timeoutMs: 1000 });
  t.after(() => backend.close());
  backend.setSession("old");
  const read = backend.readProgress();
  await backend.refreshSession();
  finish(Response.json({ code: "unauthorized" }, { status: 401 }));
  await assert.rejects(
    read,
    (error: unknown) => error instanceof BackendError && error.status === 401,
  );
  await backend.readProgress();
});

test("failed pre-expiry refresh never sends the waiting mutation", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return Response.json({ code: "unavailable" }, { status: 503 });
  });
  const backend = new Backend(options);
  t.after(() => backend.close());
  backend.setSession({ token: "old", expires_at: Date.now() / 1000 + 30 });
  await assert.rejects(
    backend.saveProgress(save),
    (error: unknown) => error instanceof BackendError && error.status === 503,
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith("/refresh"));
});

test("old-token 401 before refresh completes does not abort successful rotation", async (t) => {
  let finishRead!: (response: Response) => void;
  let finishRefresh!: (response: Response) => void;
  let refreshSignal!: AbortSignal;
  let reads = 0;
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
    if (url.endsWith("/refresh")) {
      refreshSignal = init.signal!;
      return new Promise<Response>((resolve) => {
        finishRefresh = resolve;
      });
    }
    if (++reads === 1)
      return new Promise<Response>((resolve) => {
        finishRead = resolve;
      });
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer new");
    return Promise.resolve(Response.json({ version: 1, progress }));
  });
  const backend = new Backend({ ...options, timeoutMs: 1000 });
  t.after(() => backend.close());
  backend.setSession("old");
  const read = backend.readProgress();
  const refresh = backend.refreshSession();
  finishRead(Response.json({ code: "unauthorized" }, { status: 401 }));
  await assert.rejects(
    read,
    (error: unknown) => error instanceof BackendError && error.status === 401,
  );
  assert.equal(refreshSignal.aborted, false);
  finishRefresh(
    Response.json({ token: "new", expires_at: Date.now() / 1000 + 3600 }),
  );
  assert.equal((await refresh).token, "new");
  await backend.readProgress();
});

test("requests and explicit refresh join pending rotation after old token expires", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  let finishRefresh!: (response: Response) => void;
  let refreshSignal!: AbortSignal;
  let refreshes = 0;
  let reads = 0;
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
    if (url.endsWith("/refresh")) {
      refreshes++;
      refreshSignal = init.signal!;
      return new Promise<Response>((resolve) => {
        finishRefresh = resolve;
      });
    }
    reads++;
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer new");
    return Promise.resolve(Response.json({ version: 1, progress }));
  });
  const backend = new Backend({ ...options, timeoutMs: 1000 });
  t.after(() => backend.close());
  backend.setSession({ token: "old", expires_at: 1001 });
  const refresh = backend.refreshSession();
  now = 1_002_000;
  const read = backend.readProgress();
  const secondRefresh = backend.refreshSession();
  assert.equal(refreshSignal.aborted, false);
  assert.equal(refreshes, 1);
  assert.equal(reads, 0);
  finishRefresh(Response.json({ token: "new", expires_at: 5000 }));
  await Promise.all([refresh, read, secondRefresh]);
  assert.equal(reads, 1);
  assert.equal(refreshes, 1);
});

test("401 from shared refresh clears session and rejects waiting requests", async (t) => {
  let finishRefresh!: (response: Response) => void;
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => {
    calls++;
    return new Promise<Response>((resolve) => {
      finishRefresh = resolve;
    });
  });
  const backend = new Backend({ ...options, timeoutMs: 1000 });
  t.after(() => backend.close());
  backend.setSession({ token: "old", expires_at: Date.now() / 1000 + 30 });
  const refresh = backend.refreshSession();
  const saveResult = backend.saveProgress(save);
  finishRefresh(Response.json({ code: "unauthorized" }, { status: 401 }));
  const is401 = (error: unknown) =>
    error instanceof BackendError && error.status === 401;
  await Promise.all([
    assert.rejects(refresh, is401),
    assert.rejects(saveResult, is401),
  ]);
  await assert.rejects(backend.readProgress(), /session_required/);
  assert.equal(calls, 1);
});

test("account switch still cancels requests joining rotation after old expiry", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  let finishRefresh!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
    if (url.endsWith("/refresh"))
      return new Promise<Response>((resolve) => {
        finishRefresh = resolve;
      });
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      "Bearer new-account",
    );
    return Promise.resolve(Response.json({ version: 1, progress }));
  });
  const backend = new Backend({ ...options, timeoutMs: 1000 });
  t.after(() => backend.close());
  backend.setSession({ token: "old-account", expires_at: 1001 });
  const refresh = backend.refreshSession();
  now = 1_002_000;
  const read = backend.readProgress();
  backend.setSession("new-account");
  finishRefresh(Response.json({ token: "late-old-account", expires_at: 5000 }));
  const isAbort = (error: Error) => error.name === "AbortError";
  await Promise.all([
    assert.rejects(refresh, isAbort),
    assert.rejects(read, isAbort),
  ]);
  await backend.readProgress();
});
