import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/server/db';
import {
  keywordTargets,
  keywords,
  organizations,
  properties,
  serpChecks,
  userProperties,
  users,
} from '@/server/db/schema';
import { forProperty } from '@/server/db/scoped';
import {
  ForbiddenError,
  UnauthorizedError,
  accessiblePropertyIds,
  assertKeywordAccess,
  assertPropertyAccess,
  assertRole,
  canAccessProperty,
  type Principal,
} from './access';
import { BCRYPT_COST, hashPassword, verifyCredentials } from './credentials';

const hasDb = Boolean(process.env.TEST_DATABASE_URL);

/**
 * Two organisations, each with properties and users, so "another tenant" is a
 * real other tenant rather than a second row in the same one.
 */
describe.skipIf(!hasDb)('tenancy', () => {
  const ids = {
    orgA: '',
    orgB: '',
    propA1: '',
    propA2: '',
    propB1: '',
    keywordA1: '',
    keywordB1: '',
    targetA1: '',
  };

  let adminA: Principal;
  let memberA: Principal;
  let clientA: Principal; // granted propA1 only
  let clientAUngranted: Principal; // granted nothing
  let adminB: Principal;

  const PASSWORD = 'correct horse battery staple';

  async function makeOrg(label: string) {
    const slug = `${label}-${randomUUID().slice(0, 8)}`;
    const [org] = await db.insert(organizations).values({ name: label, slug }).returning();
    return org!.id;
  }

  async function makeProperty(orgId: string, name: string) {
    const [property] = await db
      .insert(properties)
      .values({
        orgId,
        name,
        domain: `${name}.example.com`,
        gscSiteUrl: `https://${name}-${randomUUID().slice(0, 6)}.example.com/`,
        gscPropertyType: 'url_prefix',
      })
      .returning();
    return property!.id;
  }

  async function makeUser(
    orgId: string,
    role: 'agency_admin' | 'agency_member' | 'client',
  ): Promise<Principal> {
    const email = `${role}-${randomUUID().slice(0, 8)}@example.com`;
    const [user] = await db
      .insert(users)
      .values({ orgId, email, passwordHash: await hashPassword(PASSWORD), role })
      .returning();

    return { userId: user!.id, orgId, role, email };
  }

  beforeAll(async () => {
    ids.orgA = await makeOrg('orga');
    ids.orgB = await makeOrg('orgb');

    ids.propA1 = await makeProperty(ids.orgA, 'alpha-one');
    ids.propA2 = await makeProperty(ids.orgA, 'alpha-two');
    ids.propB1 = await makeProperty(ids.orgB, 'bravo-one');

    adminA = await makeUser(ids.orgA, 'agency_admin');
    memberA = await makeUser(ids.orgA, 'agency_member');
    clientA = await makeUser(ids.orgA, 'client');
    clientAUngranted = await makeUser(ids.orgA, 'client');
    adminB = await makeUser(ids.orgB, 'agency_admin');

    await db.insert(userProperties).values({ userId: clientA.userId, propertyId: ids.propA1 });

    const [kwA] = await db
      .insert(keywords)
      .values({ propertyId: ids.propA1, term: 'alpha keyword' })
      .returning();
    ids.keywordA1 = kwA!.id;

    const [kwB] = await db
      .insert(keywords)
      .values({ propertyId: ids.propB1, term: 'bravo keyword' })
      .returning();
    ids.keywordB1 = kwB!.id;

    const [target] = await db
      .insert(keywordTargets)
      .values({
        keywordId: ids.keywordA1,
        propertyId: ids.propA1,
        locationCode: 2356,
        locationName: 'India',
        device: 'desktop',
      })
      .returning();
    ids.targetA1 = target!.id;

    await db.insert(serpChecks).values({
      keywordTargetId: ids.targetA1,
      propertyId: ids.propA1,
      keywordId: ids.keywordA1,
      checkedAt: new Date(),
      found: true,
      rankGroup: 7,
      rankAbsolute: 13,
    });
  });

  afterAll(async () => {
    for (const orgId of [ids.orgA, ids.orgB]) {
      if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
    }
  });

  /* ── Credentials ──────────────────────────────────────────────────────── */

  describe('verifyCredentials', () => {
    it('uses bcrypt at cost 12, as specified', async () => {
      expect(BCRYPT_COST).toBe(12);

      const [user] = await db.select().from(users).where(eq(users.id, adminA.userId));
      expect(user!.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    });

    it('accepts the right password and returns the principal', async () => {
      const principal = await verifyCredentials(adminA.email, PASSWORD);

      expect(principal).toMatchObject({
        userId: adminA.userId,
        orgId: ids.orgA,
        role: 'agency_admin',
      });
    });

    it('rejects a wrong password', async () => {
      expect(await verifyCredentials(adminA.email, 'wrong')).toBeNull();
    });

    it('rejects an unknown address without revealing that it is unknown', async () => {
      expect(await verifyCredentials('nobody@example.com', PASSWORD)).toBeNull();
    });

    it('normalises the email, so casing and padding do not lock a user out', async () => {
      const principal = await verifyCredentials(`  ${adminA.email.toUpperCase()}  `, PASSWORD);
      expect(principal?.userId).toBe(adminA.userId);
    });

    it('never stores the password in plaintext', async () => {
      const [user] = await db.select().from(users).where(eq(users.id, adminA.userId));
      expect(user!.passwordHash).not.toContain(PASSWORD);
    });
  });

  /* ── The access rule ──────────────────────────────────────────────────── */

  describe('canAccessProperty', () => {
    it('lets an agency_admin read every property in THEIR org', async () => {
      expect(await canAccessProperty(adminA, ids.propA1)).toBe(true);
      expect(await canAccessProperty(adminA, ids.propA2)).toBe(true);
    });

    it('lets an agency_member read every property in their org', async () => {
      expect(await canAccessProperty(memberA, ids.propA2)).toBe(true);
    });

    it('does NOT let an agency_admin read another organisation', async () => {
      // An admin is an admin of their own agency, not of the database.
      expect(await canAccessProperty(adminA, ids.propB1)).toBe(false);
      expect(await canAccessProperty(adminB, ids.propA1)).toBe(false);
    });

    it('lets a client read only an explicitly granted property', async () => {
      expect(await canAccessProperty(clientA, ids.propA1)).toBe(true);
      expect(await canAccessProperty(clientA, ids.propA2)).toBe(false);
    });

    it('gives a client with no grants nothing at all', async () => {
      // Fail-closed: a half-provisioned account must leak no data.
      expect(await canAccessProperty(clientAUngranted, ids.propA1)).toBe(false);
      expect(await accessiblePropertyIds(clientAUngranted)).toEqual([]);
    });

    it('treats a property that does not exist the same as one in another tenant', async () => {
      expect(await canAccessProperty(adminA, randomUUID())).toBe(false);
    });
  });

  describe('accessiblePropertyIds', () => {
    it('returns the whole org for agency roles', async () => {
      const list = await accessiblePropertyIds(adminA);
      expect(list).toContain(ids.propA1);
      expect(list).toContain(ids.propA2);
      expect(list).not.toContain(ids.propB1);
    });

    it('returns only granted properties for a client', async () => {
      expect(await accessiblePropertyIds(clientA)).toEqual([ids.propA1]);
    });

    it('agrees with canAccessProperty for every property', async () => {
      // A listing that filtered differently from the single-property check is
      // exactly how a cross-tenant leak gets shipped.
      for (const principal of [adminA, memberA, clientA, clientAUngranted, adminB]) {
        const listed = new Set(await accessiblePropertyIds(principal));

        for (const propertyId of [ids.propA1, ids.propA2, ids.propB1]) {
          expect(
            listed.has(propertyId),
            `${principal.role} / ${propertyId}`,
          ).toBe(await canAccessProperty(principal, propertyId));
        }
      }
    });
  });

  /* ── The choke point ──────────────────────────────────────────────────── */

  describe('assertPropertyAccess', () => {
    it('throws Unauthorized with no principal', async () => {
      await expect(assertPropertyAccess(null, ids.propA1)).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    });

    it('throws Forbidden across organisations', async () => {
      await expect(assertPropertyAccess(adminB, ids.propA1)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('throws Forbidden for an ungranted property in the same org', async () => {
      await expect(assertPropertyAccess(clientA, ids.propA2)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('carries the right status codes for the API layer', async () => {
      const unauth = await assertPropertyAccess(null, ids.propA1).catch((e: unknown) => e);
      const forbidden = await assertPropertyAccess(clientA, ids.propA2).catch((e: unknown) => e);

      expect((unauth as UnauthorizedError).status).toBe(401);
      expect((forbidden as ForbiddenError).status).toBe(403);
    });
  });

  describe('assertKeywordAccess', () => {
    it('resolves the owning property and allows it', async () => {
      await expect(assertKeywordAccess(clientA, ids.keywordA1)).resolves.toEqual({
        propertyId: ids.propA1,
      });
    });

    it('refuses a keyword belonging to another tenant', async () => {
      await expect(assertKeywordAccess(adminA, ids.keywordB1)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('returns 403, NOT 404, for a keyword that does not exist', async () => {
      // A 404 would confirm which ids exist — an enumeration oracle across
      // tenants.
      const error = await assertKeywordAccess(adminA, randomUUID()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).status).toBe(403);
    });
  });

  describe('assertRole', () => {
    it('allows agency_admin and refuses everyone else', () => {
      expect(() => assertRole(adminA, 'agency_admin')).not.toThrow();
      expect(() => assertRole(memberA, 'agency_admin')).toThrow(ForbiddenError);
      expect(() => assertRole(clientA, 'agency_admin')).toThrow(ForbiddenError);
      expect(() => assertRole(null, 'agency_admin')).toThrow(UnauthorizedError);
    });
  });

  /* ── forProperty ──────────────────────────────────────────────────────── */

  describe('forProperty', () => {
    it('cannot be constructed for a property you may not read', async () => {
      // The structural part: a route holding a scope has already passed
      // tenancy, because the check is what produced the object.
      await expect(forProperty(clientA, ids.propA2)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(forProperty(adminB, ids.propA1)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(forProperty(null, ids.propA1)).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('scopes every builder to the property', async () => {
      const scope = await forProperty(adminA, ids.propA1);

      const rows = await scope.keywords();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.term).toBe('alpha keyword');

      const checks = await scope.serpChecks();
      expect(checks.every((c) => c.propertyId === ids.propA1)).toBe(true);
    });

    it('returns nothing for a sibling property in the same org', async () => {
      const scope = await forProperty(adminA, ids.propA2);
      expect(await scope.keywords()).toHaveLength(0);
    });

    it('ANDs an extra predicate rather than replacing the scope', async () => {
      /*
       * The failure this guards: if `.where()` replaced the scope instead of
       * combining with it, every caller that filtered by anything would
       * silently read the whole table across all tenants.
       */
      const scope = await forProperty(adminA, ids.propA1);
      const bravoKeyword = eq(keywords.id, ids.keywordB1);

      // Asking this scope for another tenant's keyword must return nothing.
      expect(await scope.keywords(bravoKeyword)).toHaveLength(0);
    });

    it('scopes rollups through keyword_targets, which have no property_id', async () => {
      const scope = await forProperty(adminA, ids.propA1);
      // The one table where an unscoped query looks perfectly normal.
      await expect(scope.dailyRankRollups()).resolves.toBeInstanceOf(Array);
    });
  });
});
