import assert from "node:assert/strict";
import { test } from "node:test";
import { PlatformClient, PlatformError } from "@storio/platform-sdk";

const options = {
  baseUrl: "/api/v1",
  projectId: "project-one",
  environment: "development" as const,
  clientVersion: "1.2.3",
  timeoutMs: 1000,
};
const guest = { player_id: "guest-one", credential: "test-secret" };
const custom = { custom_id: "new_account", password: "test-password" };
const guestSession = { token: "guest-token", expires_at: 4_000_000_000 };
const customSession = {
  player_id: "custom-one",
  kind: "custom",
  token_type: "Bearer",
  token: "custom-token",
  expires_at: 4_000_000_000,
};
const policy = {
  project_id: "project-one",
  environment: "development",
  policy_revision: 0,
  maintenance_active: false,
  maintenance_message: "",
  version_status: "supported",
  minimum_version: "0.0.0",
  recommended_version: "0.0.0",
  update_url: "",
};
const progress = {
  version: 1,
  progress: { schema_version: 1, stage: 2, intro_seen: true },
};

for (const kind of ["custom login", "guest startup"] as const) {
  test(`older guest login loses to newer ${kind} before that response arrives`, async (t) => {
    const old = Promise.withResolvers<Response>();
    const latest = Promise.withResolvers<Response>();
    const latestRequested = Promise.withResolvers<void>();
    const newToken =
      kind === "custom login" ? "custom-token" : "new-guest-token";
    t.mock.method(
      globalThis,
      "fetch",
      async (url: string, init: RequestInit) => {
        if (url.endsWith("/game/progress")) {
          assert.equal(
            new Headers(init.headers).get("Authorization"),
            `Bearer ${newToken}`,
          );
          return Response.json(progress);
        }
        if (url.includes("/bootstrap?")) return Response.json(policy);
        if (
          url.endsWith("/sessions/custom") ||
          JSON.parse(String(init.body)).player_id === "new-guest"
        ) {
          latestRequested.resolve();
          return latest.promise;
        }
        assert.ok(url.endsWith("/sessions"));
        return old.promise;
      },
    );
    const client = new PlatformClient(options);
    t.after(() => client.close());
    const earlier = client.login(guest);
    const newest =
      kind === "custom login"
        ? client.loginCustom(custom)
        : client.startGuestSession(async () => ({
            ...guest,
            player_id: "new-guest",
          }));
    const expectEarlierAbort = assert.rejects(earlier, { name: "AbortError" });
    const latestResult = newest.catch((error: unknown) => error);
    await latestRequested.promise;
    old.resolve(Response.json(guestSession));
    latest.resolve(
      Response.json(
        kind === "custom login"
          ? customSession
          : { ...guestSession, token: newToken },
      ),
    );
    await expectEarlierAbort;
    const result = await latestResult;
    assert.deepEqual(
      result,
      kind === "custom login"
        ? customSession
        : {
            status: "ready",
            policy,
            session: { ...guestSession, token: newToken },
          },
    );
    assert.equal((await client.readProgress()).version, 1);
  });
}

for (const failure of ["401 response", "expired token"] as const) {
  test(`old session ${failure} preserves a pending custom account selection`, async (t) => {
    const account = Promise.withResolvers<Response>();
    const requested = Promise.withResolvers<void>();
    t.mock.method(
      globalThis,
      "fetch",
      async (url: string, init: RequestInit) => {
        if (
          url.endsWith("/sessions/custom") ||
          url.endsWith("/accounts/custom")
        ) {
          requested.resolve();
          return account.promise;
        }
        const bearer = new Headers(init.headers).get("Authorization");
        assert.ok(url.endsWith("/game/progress"));
        if (bearer === "Bearer original") {
          assert.equal(failure, "401 response");
          return Response.json({ code: "unauthorized" }, { status: 401 });
        }
        assert.equal(bearer, "Bearer custom-token");
        return Response.json(progress);
      },
    );
    const client = new PlatformClient(options);
    t.after(() => client.close());
    client.setSession(
      failure === "401 response"
        ? "original"
        : { token: "original", expires_at: 1 },
    );
    const pending =
      failure === "401 response"
        ? client.loginCustom(custom)
        : client.signupCustom(custom);
    const completion = pending.catch((error: unknown) => error);
    await requested.promise;
    await assert.rejects(
      client.readProgress(),
      (error: unknown) =>
        error instanceof PlatformError &&
        error.status === 401 &&
        error.code ===
          (failure === "401 response" ? "unauthorized" : "session_expired"),
    );
    await assert.rejects(client.readProgress(), /session_required/);
    account.resolve(Response.json(customSession));
    assert.deepEqual(await completion, customSession);
    assert.equal((await client.readProgress()).version, 1);
  });
}

test("an earlier logout response clears the old token and preserves the newer custom login", async (t) => {
  const serverLogout = Promise.withResolvers<Response>();
  const serverLogin = Promise.withResolvers<Response>();
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const bearer = new Headers(init.headers).get("Authorization");
    if (init.method === "DELETE") {
      assert.ok(url.endsWith("/game/session"));
      assert.equal(bearer, "Bearer original");
      return serverLogout.promise;
    }
    if (url.endsWith("/sessions/custom")) return serverLogin.promise;
    assert.equal(bearer, "Bearer custom-token");
    return Response.json(progress);
  });
  const client = new PlatformClient(options);
  t.after(() => client.close());
  client.setSession("original");
  const loggedOut = client.logout();
  const loggedIn = client.loginCustom(custom);
  const latestResult = loggedIn.catch((error: unknown) => error);
  serverLogout.resolve(new Response(null, { status: 204 }));
  await loggedOut;
  await assert.rejects(client.readProgress(), /session_required/);
  serverLogin.resolve(Response.json(customSession));
  assert.deepEqual(await latestResult, customSession);
  assert.equal((await client.readProgress()).version, 1);
});

test("logout requested after custom login cancels that older account selection", async (t) => {
  const serverLogin = Promise.withResolvers<Response>();
  const serverLogout = Promise.withResolvers<Response>();
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (init.method === "DELETE") return serverLogout.promise;
    assert.ok(url.endsWith("/sessions/custom"));
    return serverLogin.promise;
  });
  const client = new PlatformClient(options);
  t.after(() => client.close());
  client.setSession("original");
  const loggedIn = client.loginCustom(custom);
  const canceled = assert.rejects(loggedIn, { name: "AbortError" });
  const loggedOut = client.logout();
  const logoutResult = loggedOut.catch((error: unknown) => error);
  serverLogin.resolve(Response.json(customSession));
  try {
    await canceled;
  } finally {
    serverLogout.resolve(new Response(null, { status: 204 }));
  }
  assert.equal(await logoutResult, undefined);
  await assert.rejects(client.readProgress(), /session_required/);
});

test("old session invalidation preserves guest startup while it creates credentials", async (t) => {
  const credentialsRequest = Promise.withResolvers<Response>();
  const credentialsRequested = Promise.withResolvers<void>();
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.includes("/bootstrap?")) return Response.json(policy);
    if (url.endsWith("/guests")) {
      credentialsRequested.resolve();
      return credentialsRequest.promise;
    }
    if (url.endsWith("/sessions")) return Response.json(guestSession);
    const bearer = new Headers(init.headers).get("Authorization");
    if (bearer === "Bearer original") {
      return Response.json({ code: "unauthorized" }, { status: 401 });
    }
    assert.equal(bearer, "Bearer guest-token");
    return Response.json(progress);
  });
  const client = new PlatformClient(options);
  t.after(() => client.close());
  client.setSession("original");
  const startup = client.startGuestSession((signal) =>
    client.createGuest(signal),
  );
  const startupResult = startup.catch((error: unknown) => error);
  await credentialsRequested.promise;
  await assert.rejects(
    client.readProgress(),
    (error: unknown) => error instanceof PlatformError && error.status === 401,
  );
  credentialsRequest.resolve(Response.json(guest));
  assert.deepEqual(await startupResult, {
    status: "ready",
    policy,
    session: guestSession,
  });
  assert.equal((await client.readProgress()).version, 1);
});
