import { ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import { organizations } from '../../core/database/schema';

/**
 * URL-safe identifier derived from an organisation name. Kept short and
 * conservative: only lower-case letters, digits and hyphens, so the value is
 * safe in a path, a subdomain and a container label alike.
 */
export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : 'organisation';
}

/**
 * Finds a free slug, appending a counter on collision.
 *
 * Bounded rather than looping indefinitely. The unique index on the column is
 * what actually guarantees uniqueness under concurrency; this loop only avoids
 * the common case of a predictable collision producing an error the user cannot
 * act on.
 */
export async function allocateOrganizationSlug(
  database: DatabaseService,
  name: string,
): Promise<string> {
  const base = slugify(name);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const [existing] = await database.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, candidate))
      .limit(1);

    if (!existing) return candidate;
  }

  throw new ConflictException(
    'Unable to allocate an organisation identifier. Please choose a different name.',
  );
}
