/**
 * NURAE — user vanity slugs.
 *
 * Every signed-in user gets a personal dashboard URL of the form
 *   /<username>_<uid>/dashboard
 * where <username> is their display name slugified and <uid> is the last six
 * characters of their account id (display names are not unique — the uid
 * makes the URL collision-free). Example: /maria_4f2a1c/dashboard
 */

/** Characters safe in a URL path segment. */
function slugifyName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return cleaned || 'user';
}

/** The canonical vanity slug for a user row. */
export function userSlug(user: { name: string; id: string }): string {
  return `${slugifyName(user.name)}_${user.id.slice(-6)}`;
}

/** Parse a slug into its parts (no DB lookup — callers match against real users). */
export function parseUserSlug(slug: string): { name: string; uid: string } | null {
  const idx = slug.lastIndexOf('_');
  if (idx <= 0) return null;
  const name = slug.slice(0, idx);
  const uid = slug.slice(idx + 1);
  if (!name || !/^[a-z0-9]{1,32}$/.test(uid)) return null;
  return { name, uid };
}
