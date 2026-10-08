import { Pager } from './components/pager';
import { BufferPool } from './components/buffer-pool';

export async function test() {
  const pager = new Pager('mydb.db');
  await pager.open();

  const bufferPool = new BufferPool(pager, 3); // Max 3 pages in RAM

  // 1. Allocate a page
  const pageId = await pager.allocatePage(); // Page 0

  // 2. Fetch it into memory
  const pageBuffer = await bufferPool.getPage(pageId);

  // 3. Directly manipulate binary bytes inside the page
  pageBuffer.writeUInt32BE(12345, 0); // Write an integer to bytes 0-3
  bufferPool.markDirty(pageId);       // Tell the pool this page changed

  // 4. Safely persist everything down
  await bufferPool.flushAll();
  await pager.close();
  console.log("Successfully wrote raw binary page natively!");
}
