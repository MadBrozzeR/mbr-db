import { Database } from './components/database';
import { PagerDebug } from './utils/debug-utils';

const baseName = __dirname + '/../storage.ignore.base';

export async function test() {
  const base = new Database(baseName);
  const table = await base.openTable('test');
  await table.insert([null, Buffer.alloc(950, 'v')]);
  await table.insert([null, Buffer.alloc(950, 'v')]);
  await table.insert([null, Buffer.alloc(950, 'v')]);
  await table.insert([null, Buffer.alloc(950, 'v')]);
  await table.insert([null, Buffer.alloc(950, 'v')]);
  await table.insert([null, Buffer.alloc(950, 'v')]);
  await base.close();

  const debug = new PagerDebug(baseName + '/test.db');
  await debug.showPage(0);
  await debug.showPage(1);
  await debug.showPage(2);
  await debug.showPage(3);
  await debug.showPage(4);
  await debug.showPage(5);
  await debug.showPage(6);
  await debug.showPage(7);
  await debug.showPage(8);
  await debug.showPage(9);
  await debug.showPage(10);
}
