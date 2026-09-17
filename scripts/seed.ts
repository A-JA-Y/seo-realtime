/**
 * `pnpm db:seed` — the command-line face of `src/server/db/seed`.
 *
 * All the logic lives in the module so the hosted `bootstrap-demo` job can run
 * the same seed against a deployment. This file only prints the summary and,
 * exactly once, any password that had to be generated.
 */
import { redactError } from '@/lib/redact';
import { BCRYPT_COST } from '@/server/auth/credentials';
import { seed } from '@/server/db/seed';

seed()
  .then((result) => {
    console.log('');
    console.log(`  Organization   ${result.organization.name} (${result.organization.slug})`);
    console.log(`  Property       ${result.property.name} — ${result.property.gscSiteUrl}`);
    console.log(`  Keywords       ${result.keywords}`);
    console.log(`  Targets        ${result.targets}`);
    console.log(`  Admin login    ${result.adminEmail} (agency_admin, bcrypt cost ${BCRYPT_COST})`);
    if (result.clientEmail) {
      console.log(`  Client login   ${result.clientEmail} (client, granted this property)`);
    }

    if (result.generatedPassword) {
      console.log('');
      console.log(`  Generated admin password: ${result.generatedPassword}`);
      console.log('  Shown once. Store it now, or set SEED_ADMIN_PASSWORD and re-seed.');
    }
    if (result.generatedClientPassword) {
      console.log(`  Generated client password: ${result.generatedClientPassword}`);
      console.log('  Also shown once.');
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
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(JSON.stringify({ level: 'error', job: 'seed', error: redactError(error) }));
    process.exit(1);
  });
