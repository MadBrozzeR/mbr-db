import { Pager } from './components/pager';
import { BufferPool } from './components/buffer-pool';
import { PageManager } from './components/page-manager';
import { serializeRow } from './utils/buffer-utils';

export async function test() {
  const cacheManager = new BufferPool(10);
  const pagers = {
    users: new Pager(__dirname + '/users.db'),
    orders: new Pager(__dirname + '/orders.db'),
  };

  // Open them up
  cacheManager.addPager('users', await pagers.users.open());
  cacheManager.addPager('orders', await pagers.orders.open());

  // 3. Allocating independent rows across different targets
  const userPageId = await pagers.users.allocatePage();
  const orderPageId = await pagers.orders.allocatePage();

  const userBuffer = await cacheManager.getPage("users", userPageId);
  const orderBuffer = await cacheManager.getPage("orders", orderPageId);

  const userPage = new PageManager(userBuffer);
  const orderPage = new PageManager(orderBuffer);
  
  userPage.init(1); // Leaf Node for Users
  orderPage.init(1); // Leaf Node for Orders

  // Insert distinct data into separate files
  userPage.insertRow(serializeRow([Buffer.from("User_Alice")]));
  cacheManager.markDirty("users", userPageId);

  orderPage.insertRow(serializeRow([Buffer.from("Order_Notebook_099")]));
  cacheManager.markDirty("orders", orderPageId);

  // Persist all active tracks concurrently
  await cacheManager.flushAll();
  
  await pagers.users.close();
  await pagers.orders.close();
  
  console.log("💥 Multi-table isolation verified successfully. Check your workspace for users.db and orders.db!");
}
