import { Database } from './components/database';

export async function test() {
  const db = new Database(__dirname + '/../storage.ignore/');
  const table = await db.openTable('testTable');
  const recordId = await table.insert([Buffer.from('102'), Buffer.from('Hello, World!!1')]);
  await db.close();
  console.log('Record have been added', recordId);
}
