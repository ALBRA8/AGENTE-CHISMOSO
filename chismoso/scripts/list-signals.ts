import { ChismosoDB } from '../src/db.js';
import { Repositories } from '../src/repositories.js';

const id = process.argv[2];
const db = new ChismosoDB({ path: 'data/chismoso.db' });
const r = new Repositories(db);
const sigs = r.signals.findByInvestigation(id);
console.log(`Investigation ${id}: ${sigs.length} signals`);
for (const s of sigs) {
  console.log(`- [${s.sourceType}] [${s.signalType}] ${s.rawSnippet.slice(0, 120)}`);
}
db.close();
