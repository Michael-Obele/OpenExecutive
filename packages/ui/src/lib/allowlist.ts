// Who may sign in. Two ADDITIVE sources, never one overriding the other
// (issue #132): the operator's ALLOWED_EMAILS env list is always honored, and
// the backend People roster grants access on top of it.
//
// The previous rule made the roster authoritative the moment it held a single
// email, so anything that wrote a Person row — including a fixture load, which
// wipes `people` and inserts its own @example.com addresses — silently evicted
// the operator from their own instance, with recovery requiring direct DB
// access. Under the union that cannot happen: an env entry is revocable only
// by editing the env.
//
// No imports here (not React, not next-auth) so `npm test` can exercise this
// directly under `node --experimental-strip-types` — see
// scripts/allowlist.test.mjs. auth.ts keeps only the wiring and audit calls.

/** Where an allow/deny decision came from. Recorded in audit-log `details`. */
export type AllowSource =
  /** Matched ALLOWED_EMAILS. The roster was not consulted. */
  | "env"
  /** Missed ALLOWED_EMAILS, matched the People roster. */
  | "roster"
  /** Definite miss: both lists were readable and neither had the email. */
  | "env_and_roster"
  /** Missed ALLOWED_EMAILS; the roster was unreadable, so membership is unknown. */
  | "env_only_roster_unavailable";

export type AllowDecision = {
  allowed: boolean;
  source: AllowSource;
  /** True only when the answer is "no" AND the roster could not be read. */
  rosterUnknown: boolean;
};

export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/**
 * Parse a comma-separated ALLOWED_EMAILS value. Trims, lowercases, drops
 * blanks — so whitespace around entries and trailing commas are harmless,
 * as docs/auth.md promises.
 */
export function parseAllowedEmails(
  raw: string | null | undefined,
): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter((e) => e.length > 0),
  );
}

/**
 * The union rule, as a pure function. `roster === null` means the roster could
 * not be read; an empty set means it was read and is genuinely empty.
 *
 * Note that an env hit yields `rosterUnknown: false` even when the roster is
 * unreadable — the decision never depended on the roster, so there is nothing
 * unknown about it.
 */
export function decideAllowed(
  email: string,
  envAllowed: ReadonlySet<string>,
  roster: ReadonlySet<string> | null,
): AllowDecision {
  const normalized = normalizeEmail(email);
  if (normalized.length > 0 && envAllowed.has(normalized)) {
    return { allowed: true, source: "env", rosterUnknown: false };
  }
  if (roster === null) {
    return {
      allowed: false,
      source: "env_only_roster_unavailable",
      rosterUnknown: true,
    };
  }
  if (normalized.length > 0 && roster.has(normalized)) {
    return { allowed: true, source: "roster", rosterUnknown: false };
  }
  // Both lists readable and neither matched — a definite no. An empty roster
  // lands here too, so it revokes rather than failing open.
  return { allowed: false, source: "env_and_roster", rosterUnknown: false };
}

/**
 * `decideAllowed` with the roster fetched lazily: an env hit short-circuits
 * before `loadRoster` is ever called, so an operator listed in ALLOWED_EMAILS
 * signs in with the backend completely down and pays no fetch latency.
 *
 * The flip side is that env-listed users never warm the roster cache, so the
 * first roster-only request after a restart pays the fetch. That is the right
 * trade: it buys the guarantee that the env list works when nothing else does.
 */
export async function resolveAllowed(
  email: string,
  envAllowed: ReadonlySet<string>,
  loadRoster: () => Promise<ReadonlySet<string> | null>,
): Promise<AllowDecision> {
  const normalized = normalizeEmail(email);
  if (normalized.length > 0 && envAllowed.has(normalized)) {
    return { allowed: true, source: "env", rosterUnknown: false };
  }
  return decideAllowed(normalized, envAllowed, await loadRoster());
}

/** Human clause for audit summaries. Mirrored in docs/auth.md's Debugging table. */
export function describeDenial(source: AllowSource): string {
  switch (source) {
    case "env_and_roster":
      return "not in ALLOWED_EMAILS or the people roster";
    case "env_only_roster_unavailable":
      return "not in ALLOWED_EMAILS; people roster unavailable";
    default:
      // Unreachable: `env` and `roster` are allow outcomes.
      return "not allowed";
  }
}

export type RosterLoaderOptions = {
  baseUrl: string;
  sharedSecret: string;
  ttlMs: number;
  fetchImpl: typeof fetch;
  now?: () => number;
  onWarn?: (message: string) => void;
};

/**
 * Build a cached loader for GET /auth/allowed-emails. The cache lives in the
 * returned closure (one per Next.js server instance — both NextAuth callbacks
 * run in the Node runtime), which keeps sign-in from hammering the backend and
 * bounds sign-in latency when the backend is momentarily slow.
 *
 * Returns `null` on any failure, which callers read as "roster unknown". A
 * failure is deliberately NOT cached, so the next attempt retries; and a stale
 * success is deliberately NOT served past its TTL, because "serve stale on
 * refresh failure" is a different revocation contract than the one documented.
 */
export function createRosterLoader(
  opts: RosterLoaderOptions,
): () => Promise<ReadonlySet<string> | null> {
  const { baseUrl, sharedSecret, ttlMs, fetchImpl } = opts;
  const now = opts.now ?? (() => Date.now());
  const warn = opts.onWarn ?? (() => {});
  let cache: { fetchedAt: number; emails: ReadonlySet<string> } | null = null;

  return async function loadRoster(): Promise<ReadonlySet<string> | null> {
    const at = now();
    if (cache && at - cache.fetchedAt < ttlMs) return cache.emails;
    try {
      const headers: Record<string, string> = {};
      if (sharedSecret) headers["x-api-key"] = sharedSecret;
      const res = await fetchImpl(`${baseUrl}/auth/allowed-emails`, {
        headers,
        // Sign-in is rare; don't let stale Next.js fetch caches gate access.
        cache: "no-store",
      });
      if (!res.ok) {
        warn(
          `[auth] roster fetch failed (HTTP ${res.status}); ALLOWED_EMAILS still applies, ` +
            `roster-only sign-ins are denied until the backend answers`,
        );
        return null;
      }
      // Parsing stays inside the try: a malformed body degrades to "unknown"
      // rather than throwing into NextAuth's callback.
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) {
        warn(`[auth] roster fetch returned a non-array body; treating the roster as unavailable`);
        return null;
      }
      const emails: ReadonlySet<string> = new Set(
        body
          // One row with a null email must not null out the whole roster.
          .filter((r): r is { email: string } => typeof r?.email === "string")
          .map((r) => normalizeEmail(r.email))
          .filter((e) => e.length > 0),
      );
      cache = { fetchedAt: at, emails };
      return emails;
    } catch (err) {
      warn(
        `[auth] roster fetch error; ALLOWED_EMAILS still applies, ` +
          `roster-only sign-ins are denied until the backend answers: ${String(err)}`,
      );
      return null;
    }
  };
}
