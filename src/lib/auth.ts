import { cookies } from "next/headers";
import { createUser, userExists } from "./session";

/**
 * Identity is a single anonymous cookie holding a user id.
 *
 * There are no accounts and no personal data: the cookie exists so that "films
 * you have seen" survives a refresh. Everything else lives in Postgres keyed
 * on that id.
 */

const COOKIE = "moviemap_user";
const ONE_YEAR = 60 * 60 * 24 * 365;

/** The current user id, or null if this browser has never started a session. */
export async function getUserId(): Promise<string | null> {
  const store = await cookies();
  const id = store.get(COOKIE)?.value;
  if (!id) return null;
  // A stale cookie pointing at a wiped database must not 500 every request.
  return (await userExists(id)) ? id : null;
}

/** The current user id, creating one (and setting the cookie) if needed. */
export async function requireUserId(): Promise<string> {
  const existing = await getUserId();
  if (existing) return existing;

  const id = await createUser();
  const store = await cookies();
  store.set(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: ONE_YEAR,
    path: "/",
  });
  return id;
}
