import assert from "node:assert/strict";
import test from "node:test";
import {
  createRosterLoader,
  decideAllowed,
  describeDenial,
  normalizeEmail,
  parseAllowedEmails,
  resolveAllowed,
} from "../src/lib/allowlist.ts";

const set = (...emails) => new Set(emails);
const NONE = set();

// --- parseAllowedEmails ----------------------------------------------------

test("parseAllowedEmails trims, lowercases, and drops blanks", () => {
  const parsed = parseAllowedEmails(" A@X.com , b@Y.com ,, ");
  assert.deepEqual([...parsed].sort(), ["a@x.com", "b@y.com"]);
});

test("parseAllowedEmails treats missing and empty config as no entries", () => {
  assert.equal(parseAllowedEmails(undefined).size, 0);
  assert.equal(parseAllowedEmails(null).size, 0);
  assert.equal(parseAllowedEmails("").size, 0);
  assert.equal(parseAllowedEmails(",,  ,").size, 0);
});

test("normalizeEmail lowercases and trims, and survives null", () => {
  assert.equal(normalizeEmail("  Alex@Example.COM "), "alex@example.com");
  assert.equal(normalizeEmail(null), "");
  assert.equal(normalizeEmail(undefined), "");
});

// --- decideAllowed: the union rule -----------------------------------------

test("issue #132: an ALLOWED_EMAILS entry survives a roster full of other people", () => {
  // The exact reported scenario: operator in the env list, roster populated by
  // a fixture load that knows nothing about them. Before the union fix this
  // returned { allowed: false }, locking the operator out of their own box.
  const decision = decideAllowed(
    "operator@corp.com",
    set("operator@corp.com"),
    set("jordan.avery@example.com", "sam.chen@example.com"),
  );
  assert.deepEqual(decision, { allowed: true, source: "env", rosterUnknown: false });
});

test("a roster member not in ALLOWED_EMAILS is admitted", () => {
  const decision = decideAllowed("teammate@corp.com", NONE, set("teammate@corp.com"));
  assert.deepEqual(decision, { allowed: true, source: "roster", rosterUnknown: false });
});

test("an email in neither list is denied, with both lists readable", () => {
  const decision = decideAllowed("stranger@evil.com", set("op@corp.com"), set("teammate@corp.com"));
  assert.deepEqual(decision, {
    allowed: false,
    source: "env_and_roster",
    rosterUnknown: false,
  });
});

test("an empty but readable roster revokes rather than failing open", () => {
  const decision = decideAllowed("stranger@evil.com", NONE, NONE);
  assert.deepEqual(decision, {
    allowed: false,
    source: "env_and_roster",
    rosterUnknown: false,
  });
});

test("an unreadable roster does not make an env entry uncertain", () => {
  // rosterUnknown stays false: the decision never consulted the roster, so
  // this is a definite allow, not a fail-open.
  const decision = decideAllowed("operator@corp.com", set("operator@corp.com"), null);
  assert.deepEqual(decision, { allowed: true, source: "env", rosterUnknown: false });
});

test("an unreadable roster leaves a non-env email unknown, not denied outright", () => {
  const decision = decideAllowed("teammate@corp.com", set("operator@corp.com"), null);
  assert.deepEqual(decision, {
    allowed: false,
    source: "env_only_roster_unavailable",
    rosterUnknown: true,
  });
});

test("an email in both lists is attributed to env", () => {
  const both = decideAllowed("op@corp.com", set("op@corp.com"), set("op@corp.com"));
  assert.equal(both.source, "env");
  assert.equal(both.allowed, true);
});

test("matching is case-insensitive against both lists", () => {
  assert.equal(decideAllowed("Alex@Example.COM", set("alex@example.com"), NONE).allowed, true);
  assert.equal(decideAllowed("Alex@Example.COM", NONE, set("alex@example.com")).allowed, true);
});

test("an empty email is never admitted by an empty-string list entry", () => {
  // parseAllowedEmails drops blanks, but decideAllowed is exported, so guard
  // the case where a caller hands it a hand-built set containing "".
  const decision = decideAllowed("", set(""), set(""));
  assert.equal(decision.allowed, false);
});

// --- resolveAllowed: lazy roster fetch --------------------------------------

test("an ALLOWED_EMAILS hit never touches the roster", async () => {
  // This is what makes the env list work with the backend completely down.
  let calls = 0;
  const loadRoster = async () => {
    calls += 1;
    return NONE;
  };
  const decision = await resolveAllowed("op@corp.com", set("op@corp.com"), loadRoster);
  assert.deepEqual(decision, { allowed: true, source: "env", rosterUnknown: false });
  assert.equal(calls, 0);
});

test("an ALLOWED_EMAILS miss fetches the roster exactly once", async () => {
  let calls = 0;
  const loadRoster = async () => {
    calls += 1;
    return set("teammate@corp.com");
  };
  const decision = await resolveAllowed("teammate@corp.com", NONE, loadRoster);
  assert.equal(decision.source, "roster");
  assert.equal(decision.allowed, true);
  assert.equal(calls, 1);
});

test("resolveAllowed normalizes before matching either list", async () => {
  const decision = await resolveAllowed("  Op@Corp.com ", set("op@corp.com"), async () => NONE);
  assert.equal(decision.allowed, true);
});

// --- createRosterLoader -----------------------------------------------------

const okResponse = (rows) => ({ ok: true, status: 200, json: async () => rows });

/** Records every call so header/URL/cache assertions can inspect them. */
const recordingFetch = (responder) => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return responder(calls.length);
  };
  impl.calls = calls;
  return impl;
};

test("the loader hits /auth/allowed-emails with the shared secret and no caching", async () => {
  const fetchImpl = recordingFetch(() => okResponse([{ email: "A@B.com", person_id: 1 }]));
  const load = createRosterLoader({
    baseUrl: "http://api:8000",
    sharedSecret: "s3cret",
    ttlMs: 1000,
    fetchImpl,
  });
  assert.deepEqual([...(await load())], ["a@b.com"]);
  assert.equal(fetchImpl.calls[0].url, "http://api:8000/auth/allowed-emails");
  assert.equal(fetchImpl.calls[0].init.cache, "no-store");
  assert.equal(fetchImpl.calls[0].init.headers["x-api-key"], "s3cret");
});

test("the loader omits x-api-key when no shared secret is configured", async () => {
  const fetchImpl = recordingFetch(() => okResponse([]));
  const load = createRosterLoader({
    baseUrl: "http://api:8000",
    sharedSecret: "",
    ttlMs: 1000,
    fetchImpl,
  });
  await load();
  assert.equal("x-api-key" in fetchImpl.calls[0].init.headers, false);
});

test("a successful roster is cached for its TTL and refetched after it expires", async () => {
  let clock = 0;
  const fetchImpl = recordingFetch((n) => okResponse([{ email: `p${n}@corp.com`, person_id: n }]));
  const load = createRosterLoader({
    baseUrl: "http://api:8000",
    sharedSecret: "",
    ttlMs: 1000,
    fetchImpl,
    now: () => clock,
  });
  assert.deepEqual([...(await load())], ["p1@corp.com"]);
  clock = 999;
  assert.deepEqual([...(await load())], ["p1@corp.com"]);
  assert.equal(fetchImpl.calls.length, 1, "served from cache inside the TTL");
  clock = 1000;
  assert.deepEqual([...(await load())], ["p2@corp.com"]);
  assert.equal(fetchImpl.calls.length, 2, "refetched once the TTL elapsed");
});

test("an HTTP error yields null, warns, and is not cached", async () => {
  const warnings = [];
  const fetchImpl = recordingFetch((n) =>
    n === 1 ? { ok: false, status: 500, json: async () => [] } : okResponse([{ email: "a@b.com", person_id: 1 }]),
  );
  const load = createRosterLoader({
    baseUrl: "http://api:8000",
    sharedSecret: "",
    ttlMs: 60_000,
    fetchImpl,
    now: () => 0,
    onWarn: (m) => warnings.push(m),
  });
  assert.equal(await load(), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /HTTP 500/);
  // Same instant, well inside the TTL: a failure must not poison the cache.
  assert.deepEqual([...(await load())], ["a@b.com"]);
});

test("a rejecting fetch yields null instead of throwing into NextAuth", async () => {
  const load = createRosterLoader({
    baseUrl: "http://api:8000",
    sharedSecret: "",
    ttlMs: 1000,
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(await load(), null);
});

test("a non-array body yields null rather than an empty roster", async () => {
  // An empty roster revokes; "unparseable" must not masquerade as that.
  const load = createRosterLoader({
    baseUrl: "http://api:8000",
    sharedSecret: "",
    ttlMs: 1000,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ detail: "nope" }) }),
  });
  assert.equal(await load(), null);
});

test("a row with a null email is skipped without nulling the whole roster", async () => {
  const load = createRosterLoader({
    baseUrl: "http://api:8000",
    sharedSecret: "",
    ttlMs: 1000,
    fetchImpl: async () =>
      okResponse([{ email: null, person_id: 1 }, { email: "Real@Corp.com", person_id: 2 }, {}]),
  });
  assert.deepEqual([...(await load())], ["real@corp.com"]);
});

test("a body that fails to parse as JSON yields null", async () => {
  const load = createRosterLoader({
    baseUrl: "http://api:8000",
    sharedSecret: "",
    ttlMs: 1000,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }),
  });
  assert.equal(await load(), null);
});

// --- describeDenial ---------------------------------------------------------

test("denial clauses read as audit summaries and match docs/auth.md", () => {
  assert.equal(describeDenial("env_and_roster"), "not in ALLOWED_EMAILS or the people roster");
  assert.equal(
    describeDenial("env_only_roster_unavailable"),
    "not in ALLOWED_EMAILS; people roster unavailable",
  );
});
