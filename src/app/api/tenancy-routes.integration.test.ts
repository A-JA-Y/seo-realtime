import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/server/db';
import {
  keywordTargets,
  keywords,
  organizations,
  properties,
  userProperties,
  users,
} from '@/server/db/schema';
import type { Principal } from '@/server/auth/access';
import { hashPassword } from '@/server/auth/credentials';

/**
 * Acceptance criterion 6, at the API layer:
 *
 *   "A client user cannot read another property's data through any route —
 *    proven by test."
 *
 * The route handlers are exercised for real against a real database. Only the
 * session decode is stubbed — `currentPrincipal` is where a signed JWT becomes
 * a principal, and nothing below it is mocked, so the access checks, the
 * scoped builder and the SQL all run exactly as they do in production.
 */
let principal: Principal | null = null;

vi.mock('@/server/auth/config', () => ({
  currentPrincipal: async () => principal,
}));

const hasDb = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasDb)('cross-tenant isolation at the API layer', () => {
  const ids = { orgA: '', orgB: '', propA1: '', propA2: '', propB1: '', kwA1: '', kwB1: '' };

  let adminA: Principal;
  let clientA: Principal;
  let adminB: Principal;

  async function makeOrg(label: string) {
    const [org] = await db
      .insert(organizations)
      .values({ name: label, slug: `${label}-${randomUUID().slice(0, 8)}` })
      .returning();
    return org!.id;
  }

  async function makeProperty(orgId: string, name: string) {
    const [row] = await db
      .insert(properties)
      .values({
        orgId,
        name,
        domain: `${name}.example.com`,
        gscSiteUrl: `https://${name}-${randomUUID().slice(0, 6)}.example.com/`,
        gscPropertyType: 'url_prefix',
      })
      .returning();
    return row!.id;
  }

  async function makeUser(orgId: string, role: Principal['role']): Promise<Principal> {
    const email = `${role}-${randomUUID().slice(0, 8)}@example.com`;
    const [user] = await db
      .insert(users)
      .values({ orgId, email, passwordHash: await hashPassword('pw-for-tests'), role })
      .returning();
    return { userId: user!.id, orgId, role, email };
  }

  beforeAll(async () => {
    ids.orgA = await makeOrg('routea');
    ids.orgB = await makeOrg('routeb');
    ids.propA1 = await makeProperty(ids.orgA, 'route-alpha-one');
    ids.propA2 = await makeProperty(ids.orgA, 'route-alpha-two');
    ids.propB1 = await makeProperty(ids.orgB, 'route-bravo-one');

    adminA = await makeUser(ids.orgA, 'agency_admin');
    clientA = await makeUser(ids.orgA, 'client');
    adminB = await makeUser(ids.orgB, 'agency_admin');

    await db.insert(userProperties).values({ userId: clientA.userId, propertyId: ids.propA1 });

    const [kwA] = await db
      .insert(keywords)
      .values({ propertyId: ids.propA1, term: 'route alpha keyword' })
      .returning();
    ids.kwA1 = kwA!.id;

    const [kwB] = await db
      .insert(keywords)
      .values({ propertyId: ids.propB1, term: 'route bravo keyword' })
      .returning();
    ids.kwB1 = kwB!.id;

    await db.insert(keywordTargets).values({
      keywordId: ids.kwA1,
      propertyId: ids.propA1,
      locationCode: 2356,
      locationName: 'India',
      device: 'desktop',
    });
  });

  afterAll(async () => {
    for (const orgId of [ids.orgA, ids.orgB]) {
      if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
    }
  });

  beforeEach(() => {
    principal = null;
  });

  const getProperties = async () => {
    const { GET } = await import('./properties/route');
    return GET();
  };

  const getKeyword = async (id: string) => {
    const { GET } = await import('./keywords/[id]/route');
    return GET(new Request(`https://x.test/api/keywords/${id}`), {
      params: Promise.resolve({ id }),
    });
  };

  /* ── GET /api/properties ──────────────────────────────────────────────── */

  describe('GET /api/properties', () => {
    it('401s an anonymous request', async () => {
      const response = await getProperties();
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe('UNAUTHORIZED');
    });

    it('lists only the caller\'s organisation for an agency admin', async () => {
      principal = adminA;
      const body = await (await getProperties()).json();
      const listed = body.properties.map((p: { id: string }) => p.id);

      expect(listed).toContain(ids.propA1);
      expect(listed).toContain(ids.propA2);
      expect(listed).not.toContain(ids.propB1);
    });

    it('lists only GRANTED properties for a client', async () => {
      principal = clientA;
      const body = await (await getProperties()).json();
      const listed = body.properties.map((p: { id: string }) => p.id);

      expect(listed).toEqual([ids.propA1]);
      expect(listed).not.toContain(ids.propA2);
    });

    it('never leaks another organisation to its admin', async () => {
      principal = adminB;
      const body = await (await getProperties()).json();
      const listed = body.properties.map((p: { id: string }) => p.id);

      expect(listed).toContain(ids.propB1);
      expect(listed).not.toContain(ids.propA1);
      expect(listed).not.toContain(ids.propA2);
    });
  });

  /* ── GET /api/keywords/:id ────────────────────────────────────────────── */

  describe('GET /api/keywords/:id', () => {
    it('401s an anonymous request', async () => {
      expect((await getKeyword(ids.kwA1)).status).toBe(401);
    });

    it('returns the keyword to someone who may read it', async () => {
      principal = clientA;
      const response = await getKeyword(ids.kwA1);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.keyword.term).toBe('route alpha keyword');
      // Every number is labelled with its source (acceptance criterion 7).
      expect(body.searchConsole.source).toMatch(/Search Console/);
    });

    it('403s a client reading a keyword in an UNGRANTED property of their own org', async () => {
      const [ungranted] = await db
        .insert(keywords)
        .values({ propertyId: ids.propA2, term: 'ungranted keyword' })
        .returning();

      principal = clientA;
      const response = await getKeyword(ungranted!.id);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.code).toBe('FORBIDDEN');
      // The response must not carry the keyword itself.
      expect(JSON.stringify(body)).not.toContain('ungranted keyword');

      await db.delete(keywords).where(eq(keywords.id, ungranted!.id));
    });

    it('403s an admin reading ANOTHER ORGANISATION\'S keyword', async () => {
      principal = adminA;
      const response = await getKeyword(ids.kwB1);

      expect(response.status).toBe(403);
      expect(JSON.stringify(await response.json())).not.toContain('route bravo keyword');
    });

    it('403s — not 404 — for a keyword that does not exist', async () => {
      // A 404 would confirm which ids exist, turning this into a
      // cross-tenant enumeration oracle.
      principal = adminA;
      const response = await getKeyword(randomUUID());

      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('FORBIDDEN');
    });

    it('400s a malformed id rather than reaching the database', async () => {
      principal = adminA;
      const response = await getKeyword('not-a-uuid');

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_INPUT');
    });

    it('leaks nothing about another tenant in ANY response body', async () => {
      // The criterion is "cannot read another property's data through any
      // route". Sweep every failure mode for the other tenant's strings.
      principal = clientA;

      const responses = await Promise.all([
        getKeyword(ids.kwB1),
        getKeyword(randomUUID()),
        getProperties(),
      ]);

      for (const response of responses) {
        const text = JSON.stringify(await response.json());
        expect(text).not.toContain('route bravo');
        expect(text).not.toContain(ids.propB1);
        expect(text).not.toContain(ids.orgB);
      }
    });
  });
});
