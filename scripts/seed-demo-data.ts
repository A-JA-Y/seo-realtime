/**
 * `pnpm db:demo` / `pnpm db:demo --clear` — the command-line face of
 * `src/server/db/demo`. The hosted `bootstrap-demo` job runs the same module.
 */
import { redactError } from '@/lib/redact';
import { clearDemoData, demoProperty, seedDemoData } from '@/server/db/demo';

async function main() {
  const property = await demoProperty();
  console.log(`\n  Property: ${property.name}`);

  if (process.argv.includes('--clear')) {
    await clearDemoData(property.id);
    console.log('  demo data removed (checks, Search Console rows, rollups, alerts)\n');
    return;
  }

  const r = await seedDemoData(property.id);
  console.log(`  Search Console rows : ${r.gscRows}`);
  console.log(`  SERP checks         : ${r.checkRows}`);
  console.log(`  Daily rollups       : ${r.rollups}`);
  console.log(`  Alerts raised       : ${r.alertsRaised} (${r.alertsOpen} still open)`);
  console.log('\n  This is SYNTHETIC data. Run with --clear to remove it.\n');
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(JSON.stringify({ level: 'error', job: 'demo', error: redactError(error) }));
    process.exit(1);
  });
