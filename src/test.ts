import { Database } from './components/database';
import { debugPage } from './utils/debug-utils';

export async function test() {
  const db = new Database(__dirname + '/../storage.ignore.base/');
  const table = await db.openTable('testTable');
  const recordIds: any[] = [];
  // recordIds.push(await table.insert([Buffer.from([1]), Buffer.from('01')]));
  // recordIds.push(await table.insert([Buffer.from([15]), Buffer.from('15')]));
  // recordIds.push(await table.insert([Buffer.from([10]), Buffer.from('10')]));
  // recordIds.push(await table.insert([Buffer.from([2]), Buffer.from('02')]));
  // recordIds.push(await table.insert([Buffer.from([25]), Buffer.from('25')]));
  // recordIds.push(await table.insert([Buffer.from([17]), Buffer.from('17')]));
  debugPage(await table.getRawPage(0));
  await db.close();
  console.log('Record have been added', recordIds);
}
