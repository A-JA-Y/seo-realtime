import { randomBytes } from 'node:crypto';

import bcrypt from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';

import { env } from '@/lib/env';
import { redactError } from '@/lib/redact';
import { db } from './index';
import {
  LOCATIONS,
  SEED_KEYWORDS,
  SEED_ORG,
  SEED_PROPERTY,
  SEED_TARGETS,
} from './seed-data';
import { keywordTargets, keywords, organizations, properties, users } from './schema';

/** bcrypt cost 12, as specified. */
const BCRYPT_COST = 12;

function log(message: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level: 'info', job: 'seed', message, ...extra }));
}

/**
 * Seeds one organisation, one agency_admin, the first property and its
 * keywords/targets.
 *
 * Idempotent by construction (domain rule 9): every insert declares the
 * table's natural key in `onConflictDoUpdate`, so re-running changes nothing
 * but the updatable columns. Existing passwords are never overwritten — that
 * would silently lock out an admin who has since changed theirs.
 */
async function seed() {
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
      passwordHash: await bcrypt.hash(password, BCRYPT_COST),
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

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('');
  console.log(`  Organization   ${org.name} (${org.slug})`);
  console.log(`  Property       ${property.name} — ${property.gscSiteUrl}`);
  console.log(`  Keywords       ${insertedKeywords.length}`);
  console.log(`  Targets        ${insertedTargets.length}`);
  console.log(`  Admin login    ${adminEmail}`);

  if (generatedPassword) {
    console.log('');
    console.log(`  Generated admin password: ${generatedPassword}`);
    console.log('  Shown once. Store it now, or set SEED_ADMIN_PASSWORD and re-seed.');
  }

  console.log('');
  console.warn(
    '  ! Verify location codes before the first paid SERP run:\n' +
      '    curl -s https://api.dataforseo.com/v3/serp/google/locations -H "Authorization: Basic $CREDS" \\\n' +
      '      | jq \'.tasks[0].result[] | select(.country_iso_code=="IN")\n' +
      '             | select(.location_name|test("Noida|India$";"i"))\n' +
      '             | {location_code, location_name, location_type}\'\n' +
      '    A stale code returns rankings for the wrong geography without erroring.',
  );
  console.log('');
}

seed()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(
      JSON.stringify({
        level: 'error',
        job: 'seed',
        error: redactError(error),
      }),
    );
    process.exit(1);
  });
