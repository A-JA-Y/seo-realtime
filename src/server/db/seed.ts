import { randomBytes } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import { env } from '@/lib/env';
import { hashPassword } from '@/server/auth/credentials';
import { db } from './index';
import {
  LOCATIONS,
  SEED_KEYWORDS,
  SEED_ORG,
  SEED_PROPERTY,
  SEED_TARGETS,
} from './seed-data';
import {
  keywordTargets,
  keywords,
  organizations,
  properties,
  userProperties,
  users,
} from './schema';

function log(message: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level: 'info', job: 'seed', message, ...extra }));
}

export interface SeedResult {
  organization: { name: string; slug: string };
  property: { id: string; name: string; gscSiteUrl: string };
  keywords: number;
  targets: number;
  adminEmail: string;
  clientEmail: string | null;
  /** Non-null only when the password was not supplied and had to be minted. */
  generatedPassword: string | null;
  generatedClientPassword: string | null;
}

/**
 * Seeds one organisation, one agency_admin, the first property and its
 * keywords/targets.
 *
 * Idempotent by construction (domain rule 9): every insert declares the
 * table's natural key in `onConflictDoUpdate`, so re-running changes nothing
 * but the updatable columns. Existing passwords are never overwritten — that
 * would silently lock out an admin who has since changed theirs.
 *
 * A MODULE, not a script: `scripts/seed.ts` is the command-line wrapper, and
 * the `bootstrap-demo` job calls this directly so a hosted deployment can be
 * seeded without a local Postgres client. Returns a structured result rather
 * than printing, because the two callers report it differently — and because
 * a generated password must reach exactly one place, once.
 */
export async function seed(): Promise<SeedResult> {
  const [org] = await db
    .insert(organizations)
    .values({ name: SEED_ORG.name, slug: SEED_ORG.slug })
    .onConflictDoUpdate({
      target: organizations.slug,
      set: { name: SEED_ORG.name },
    })
    .returning();

  if (!org) throw new Error('Failed to upsert the seed organization');
  log('organization ready', { slug: org.slug });

  // ── Admin user ────────────────────────────────────────────────────────────
  const adminEmail = (env.SEED_ADMIN_EMAIL ?? 'admin@example.com').toLowerCase();

  const existingAdmin = await db.query.users.findFirst({
    where: eq(users.email, adminEmail),
    columns: { id: true },
  });

  let generatedPassword: string | null = null;
  let generatedClientPassword: string | null = null;

  if (existingAdmin) {
    // Keep the existing hash. Re-seeding must not reset a live credential.
    await db
      .update(users)
      .set({ orgId: org.id, role: 'agency_admin' })
      .where(eq(users.id, existingAdmin.id));
    log('admin user already present — password left unchanged', { email: adminEmail });
  } else {
    const password = env.SEED_ADMIN_PASSWORD ?? randomBytes(12).toString('base64url');
    if (!env.SEED_ADMIN_PASSWORD) generatedPassword = password;

    await db.insert(users).values({
      orgId: org.id,
      email: adminEmail,
      passwordHash: await hashPassword(password),
      name: 'Agency Admin',
      role: 'agency_admin',
    });
    log('admin user created', { email: adminEmail });
  }

  // ── Property ──────────────────────────────────────────────────────────────
  const [property] = await db
    .insert(properties)
    .values({
      orgId: org.id,
      name: SEED_PROPERTY.name,
      domain: SEED_PROPERTY.domain,
      gscSiteUrl: SEED_PROPERTY.gscSiteUrl,
      gscPropertyType: SEED_PROPERTY.gscPropertyType,
      timezone: SEED_PROPERTY.timezone,
    })
    .onConflictDoUpdate({
      target: [properties.orgId, properties.gscSiteUrl],
      set: {
        name: SEED_PROPERTY.name,
        domain: SEED_PROPERTY.domain,
        gscPropertyType: SEED_PROPERTY.gscPropertyType,
        timezone: SEED_PROPERTY.timezone,
      },
    })
    .returning();

  if (!property) throw new Error('Failed to upsert the seed property');
  log('property ready', { domain: property.domain, gscSiteUrl: property.gscSiteUrl });

  /*
   * ── A demonstration client ──────────────────────────────────────────────
   *
   * Created so the access model is exercisable immediately rather than only
   * described: this account is scoped to exactly one property through
   * `user_properties`, which is what a real retainer client looks like.
   * Skipped unless SEED_CLIENT_EMAIL is set, so a production seed does not
   * quietly create an extra login.
   */
  let clientEmail: string | null = null;

  if (env.SEED_CLIENT_EMAIL) {
    clientEmail = env.SEED_CLIENT_EMAIL.toLowerCase();

    const existing = await db.query.users.findFirst({
      where: eq(users.email, clientEmail),
      columns: { id: true },
    });

    let clientId = existing?.id;

    if (!clientId) {
      const password = env.SEED_CLIENT_PASSWORD ?? randomBytes(12).toString('base64url');
      if (!env.SEED_CLIENT_PASSWORD) generatedClientPassword = password;

      const [created] = await db
        .insert(users)
        .values({
          orgId: org.id,
          email: clientEmail,
          passwordHash: await hashPassword(password),
          name: 'Client',
          role: 'client',
        })
        .returning({ id: users.id });
      clientId = created!.id;
      log('client user created', { email: clientEmail });
    }

    await db
      .insert(userProperties)
      .values({ userId: clientId, propertyId: property.id })
      .onConflictDoNothing();
  }

  // ── Keywords ──────────────────────────────────────────────────────────────
  const insertedKeywords = await db
    .insert(keywords)
    .values(
      SEED_KEYWORDS.map((k) => ({
        propertyId: property.id,
        term: k.term,
        isPrimary: k.isPrimary,
      })),
    )
    .onConflictDoUpdate({
      target: [keywords.propertyId, keywords.term],
      // `excluded` is the row we tried to insert — re-seeding refreshes the
      // primary flag and reactivates a keyword that was switched off.
      set: {
        isPrimary: sql`excluded.is_primary`,
        isActive: sql`excluded.is_active`,
      },
    })
    .returning();

  log('keywords ready', { count: insertedKeywords.length });

  // ── Targets: keyword × location × device ──────────────────────────────────
  const targetRows = insertedKeywords.flatMap((keyword) => {
    const seed = SEED_KEYWORDS.find((k) => k.term === keyword.term);
    return SEED_TARGETS.map((t) => {
      const location = LOCATIONS[t.location];
      return {
        keywordId: keyword.id,
        propertyId: property.id,
        locationCode: location.locationCode,
        locationName: location.locationName,
        languageCode: 'en',
        device: t.device,
        checkIntervalMin: seed?.isPrimary ? t.intervalPrimaryMin : t.intervalSecondaryMin,
      };
    });
  });

  const insertedTargets = await db
    .insert(keywordTargets)
    .values(targetRows)
    .onConflictDoUpdate({
      target: [
        keywordTargets.keywordId,
        keywordTargets.locationCode,
        keywordTargets.device,
        keywordTargets.languageCode,
      ],
      set: { isActive: true },
    })
    .returning({ id: keywordTargets.id });

  log('keyword targets ready', { count: insertedTargets.length });

  return {
    organization: { name: org.name, slug: org.slug },
    property: { id: property.id, name: property.name, gscSiteUrl: property.gscSiteUrl },
    keywords: insertedKeywords.length,
    targets: insertedTargets.length,
    adminEmail,
    clientEmail,
    generatedPassword,
    generatedClientPassword,
  };
}
