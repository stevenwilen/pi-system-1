// Who a request is.
//
// The token says, and nothing else does. There is no default user, no
// environment variable to point this at someone, and no fallback when the
// header is missing — a request without a valid token is not a request from
// anybody, and it is refused.
//
// This replaced a fixed uuid read from PI_USER_ID. That was honest while there
// was one person, but it meant identity arrived from the server's own
// configuration rather than from the caller, so the same deployment could only
// ever serve one person and no request could be wrong about who it was.

require('dotenv').config();

const { url, anonKey } = require('./db');

/**
 * Verified tokens, briefly.
 *
 * Verification is a call to Supabase, and the page makes four requests on load.
 * Without this every one of them pays that round trip.
 *
 * Caching a token is not caching a decision about a person: the key IS the
 * proof, and it cannot be forged. A token that stops being valid within the
 * window is one that was already valid when issued and would have been
 * accepted anyway — signing out does not revoke an access token, it discards
 * it, and it expires on its own schedule regardless of what is remembered here.
 */
const CACHE = new Map();
const TTL_MS = 60 * 1000;
const MAX = 500;

function remember(token, user) {
  // Oldest out first. A Map iterates in insertion order, so the first key is
  // the coldest.
  if (CACHE.size >= MAX) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(token, { user, at: Date.now() });
}

/** Only for tests, which mint and expire tokens faster than the window. */
function forgetTokens() {
  CACHE.clear();
}

/**
 * The user a token stands for, or null.
 *
 * Asked of Supabase rather than decoded here. A JWT's payload is readable by
 * anyone holding it, so reading `sub` out of it locally would be trusting the
 * caller's own description of themselves; only the signature makes it a claim,
 * and checking that is what this call does.
 */
async function userFrom(accessToken) {
  if (!accessToken || typeof accessToken !== 'string') return null;

  const hit = CACHE.get(accessToken);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.user;
  if (hit) CACHE.delete(accessToken);

  if (!anonKey) {
    throw new Error('Missing SUPABASE_ANON_KEY in .env — no token can be verified without it');
  }

  let res;
  try {
    res = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    // Unreachable is not the same as invalid, but a request cannot be served
    // either way and saying "no" is the safe half of the mistake.
    return null;
  }

  if (!res.ok) return null;

  const body = await res.json().catch(() => null);
  if (!body || !body.id) return null;

  const user = { id: body.id, email: body.email || null };
  remember(accessToken, user);
  return user;
}

/** The token out of an Authorization header, or null. */
function bearer(header) {
  const m = /^Bearer\s+(.+)$/i.exec(String(header || '').trim());
  return m ? m[1].trim() : null;
}

module.exports = { userFrom, bearer, forgetTokens };
