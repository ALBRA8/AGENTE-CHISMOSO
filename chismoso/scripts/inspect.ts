import { ChismosoDB } from '../src/db.js';
import { Repositories } from '../src/repositories.js';

const id = process.argv[2];
const db = new ChismosoDB({ path: 'data/chismoso.db' });
const r = new Repositories(db);
const inv = r.investigations.get(id);
if (!inv) {
  console.error('Not found:', id);
  process.exit(1);
}
console.log('status:', inv.status);
console.log('providersUsed:', inv.providersUsed);
console.log('queriesExecuted count:', inv.queriesExecuted.length);
console.log('queriesExecuted:', JSON.stringify(inv.queriesExecuted, null, 2));
console.log('errors count:', inv.errors.length);
console.log('errors:', JSON.stringify(inv.errors, null, 2));
console.log('providerRuns count:', inv.providerRuns.length);
console.log('providerRuns:', JSON.stringify(inv.providerRuns, null, 2));
db.close();
