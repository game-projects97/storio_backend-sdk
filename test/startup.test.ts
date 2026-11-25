import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PlatformClient,
  PlatformError,
  type Bootstrap,
} from "@storio/platform-sdk";

const options = {
  baseUrl: "/api/v1",
  projectId: "project-one",
  environment: "development" as const,
  clientVersion: "1.2.3",
};
const policy: Bootstrap = {
  project_id: "project-one",
  environment: "development",
  policy_revision: 1,
  maintenance_active: false,
  maintenance_message: "",
  version_status: "supported",
  minimum_version: "0.0.0",
  recommended_version: "1.2.3",
  update_url: "",
};
const guest = { player_id: "guest-one", credential: "secret" };
const session = {
  token: "guest-token",
  expires_at: 4_000_000_000,
  token_type: "Bearer",
};
const progress = {
  version: 0,
  progress: { schema_version: 1, stage: 1, intro_seen: false },
};

test("maintenance takes priority over a required update and leaves credentials untouched", async (t) => {
  const both: Bootstrap = {
    ...policy,
    maintenance_active: true,
    maintenance_message: "잠시 점검 중입니다.",
    version_status: "required",
    minimum_version: "2.0.0",
    recommended_version: "2.0.0",
    update_url: "https://example.com/update",
  };
  t.mock.method(globalThis, "fetch", async () => Response.json(both));
  const client = new PlatformClient(options);
  t.after(() => client.close());
  const result = await client.startGuestSession(async () =>
    assert.fail("점검 중에는 자격을 읽지 않는다"),
  );
  assert.deepEqual(result, { status: "maintenance", policy: both });
});

test("a required update returns its URL without loading guest credentials", async (t) => {
  const required: Bootstrap = {
    ...policy,
    version_status: "required",
    minimum_version: "2.0.0",
    recommended_version: "2.0.0",
    update_url: "https://example.com/update",
  };
  t.mock.method(globalThis, "fetch", async () => Response.json(required));
  const client = new PlatformClient(options);
  t.after(() => client.close());
  const result = await client.startGuestSession(async () =>
    assert.fail("업데이트 전에는 자격을 읽지 않는다"),
  );
  assert.deepEqual(result, { status: "update_required", policy: required });
});

test("same guest startup shares pending and successful results with independent caller cancellation", async (t) => {
  const recommended: Bootstrap = {
    ...policy,
    version_status: "recommended",
    recommended_version: "2.0.0",
    update_url: "https://example.com/update",
  };
  const credentialsRequested = Promise.withResolvers<AbortSignal | undefined>();
  const credentials = Promise.withResolvers<typeof guest>();
  const urls: string[] = [];
  let credentialReads = 0;
  const getCredentials = (signal?: AbortSignal) => {
    credentialReads += 1;
    credentialsRequested.resolve(signal);
    return credentials.promise;
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    urls.push(url);
    if (url.includes("/bootstrap?")) return Response.json(recommended);
    if (url.endsWith("/sessions")) {
      assert.deepEqual(JSON.parse(String(init.body)), guest);
      return Response.json(session);
    }
    if (url.endsWith("/session/refresh")) {
      return Response.json({ ...session, token: "rotated" });
    }
    assert.ok(url.endsWith("/game/progress"));
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      "Bearer guest-token",
    );
    return Response.json(progress);
  });
  const client = new PlatformClient(options);
  t.after(() => client.close());
  const first = new AbortController();
  const canceled = client.startGuestSession(getCredentials, first.signal);
  const shared = client.startGuestSession(getCredentials);
  const innerSignal = await credentialsRequested.promise;
  first.abort();
  assert.equal(innerSignal?.aborted, false);
  await assert.rejects(canceled, { name: "AbortError" });
  credentials.resolve(guest);
  assert.deepEqual(await shared, {
    status: "ready",
    policy: recommended,
    session,
  });
  assert.equal((await client.readProgress()).version, 0);
  const cached = await client.startGuestSession(getCredentials);
  assert.equal(
    cached.status === "ready" && cached.session.token,
    "guest-token",
  );
  assert.equal((await client.refreshSession()).token, "rotated");
  const rotated = await client.startGuestSession(getCredentials);
  assert.equal(rotated.status === "ready" && rotated.session.token, "rotated");
  assert.equal(credentialReads, 1);
  assert.deepEqual(urls, [
    "/api/v1/game/project-one/development/bootstrap?client_version=1.2.3",
    "/api/v1/game/project-one/development/sessions",
    "/api/v1/game/progress",
    "/api/v1/game/session/refresh",
  ]);
});

for (const status of ["maintenance", "update_required"] as const) {
  test(`startup refreshes policy after ${status} during guest authentication`, async (t) => {
    const revised: Bootstrap = {
      ...policy,
      policy_revision: 2,
      maintenance_active: status === "maintenance",
      maintenance_message: status === "maintenance" ? "새 점검 메시지" : "",
      version_status: "required",
      minimum_version: "2.0.0",
      recommended_version: "2.0.0",
      update_url: "https://example.com/new",
    };
    let reads = 0;
    let authenticationRequests = 0;
    t.mock.method(globalThis, "fetch", async (url: string) => {
      if (url.includes("/bootstrap?")) {
        reads += 1;
        return Response.json(reads === 1 ? policy : revised);
      }
      authenticationRequests += 1;
      assert.ok(
        url.endsWith(status === "maintenance" ? "/guests" : "/sessions"),
      );
      return Response.json(
        { code: status },
        { status: status === "maintenance" ? 503 : 426 },
      );
    });
    const client = new PlatformClient(options);
    t.after(() => client.close());
    const getCredentials = (signal?: AbortSignal) =>
      status === "maintenance"
        ? client.createGuest(signal)
        : Promise.resolve(guest);
    assert.deepEqual(await client.startGuestSession(getCredentials), {
      status,
      policy: revised,
    });
    assert.equal(reads, 2);
    assert.equal(authenticationRequests, 1);
    await assert.rejects(client.readProgress(), /session_required/);
  });
}

test("a failed fetch is temporary, can be retried explicitly and never requests credentials", async (t) => {
  let count = 0;
  const offline = new TypeError("Failed to fetch");
  t.mock.method(globalThis, "fetch", async () => {
    count += 1;
    if (count === 1) throw offline;
    return Response.json({
      ...policy,
      maintenance_active: true,
      maintenance_message: "점검 중입니다.",
    });
  });
  const client = new PlatformClient(options);
  t.after(() => client.close());
  const getCredentials = async () =>
    assert.fail("정책이 없으면 자격을 읽지 않는다");
  assert.deepEqual(await client.startGuestSession(getCredentials), {
    status: "temporary_failure",
    error: offline,
  });
  assert.equal(
    (await client.startGuestSession(getCredentials)).status,
    "maintenance",
  );
  assert.equal(count, 2);
});

test("permanent authentication and credential errors propagate", async (t) => {
  const storageError = new TypeError("Invalid local credential value");
  t.mock.method(globalThis, "fetch", async (url: string) =>
    url.endsWith("/sessions")
      ? Response.json({ code: "unauthorized" }, { status: 401 })
      : Response.json(policy),
  );
  const client = new PlatformClient(options);
  t.after(() => client.close());
  await assert.rejects(
    client.startGuestSession(async () => guest),
    (error: unknown) =>
      error instanceof PlatformError &&
      error.status === 401 &&
      error.code === "unauthorized",
  );
  await assert.rejects(
    client.startGuestSession(async () => {
      throw storageError;
    }),
    (error: unknown) => error === storageError,
  );
});

test("an account switch cancels startup before a delayed credential callback resolves", async (t) => {
  const credentialsRequested = Promise.withResolvers<void>();
  const credentials = Promise.withResolvers<typeof guest>();
  const auth: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.includes("/bootstrap?")) return Response.json(policy);
    auth.push(new Headers(init.headers).get("Authorization"));
    assert.ok(url.endsWith("/game/progress"));
    return Response.json(progress);
  });
  const client = new PlatformClient(options);
  t.after(() => client.close());
  const pending = client.startGuestSession(() => {
    credentialsRequested.resolve();
    return credentials.promise;
  });
  await credentialsRequested.promise;
  client.setSession("new-account");
  await assert.rejects(pending, { name: "AbortError" });
  credentials.resolve(guest);
  await client.readProgress();
  assert.deepEqual(auth, ["Bearer new-account"]);
});

test("canceling the last startup caller prevents a late login response from replacing the session", async (t) => {
  const loginRequested = Promise.withResolvers<AbortSignal | undefined>();
  const login = Promise.withResolvers<Response>();
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.includes("/bootstrap?")) return Response.json(policy);
    if (url.endsWith("/sessions")) {
      loginRequested.resolve(init.signal ?? undefined);
      return login.promise;
    }
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      "Bearer existing",
    );
    return Response.json(progress);
  });
  const client = new PlatformClient(options);
  t.after(() => client.close());
  client.setSession("existing");
  const caller = new AbortController();
  const pending = client.startGuestSession(async () => guest, caller.signal);
  const transportSignal = await loginRequested.promise;
  caller.abort();
  assert.equal(transportSignal?.aborted, true);
  await assert.rejects(pending, { name: "AbortError" });
  login.resolve(Response.json(session));
  assert.equal((await client.readProgress()).version, 0);
});
