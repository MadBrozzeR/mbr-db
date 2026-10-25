import { BufferPool } from './buffer-pool';
import { PageManager } from './page-manager';
import { Pager } from './pager';
import { DEFAULT_POOL_COUNT, PAGE_TYPE, PageType } from '../constants';
import { AppError } from '../utils/errors';

export class PagePool {
  bufferPool: BufferPool;
  pagers: Record<string, Pager> = {};
  openPagers: Record<string, Pager> = {};
  pageManager = new PageManager();

  constructor(number = DEFAULT_POOL_COUNT) {
    this.bufferPool = new BufferPool(number);
  }

  async setPager(name: string, pathName: string, open = true) {
      const pager = new Pager(pathName);
      this.pagers[name] = pager;
      this.bufferPool.addPager(name, pager);
      return open ? await this.open(name) : pager;
  }

  async setPagers(pagers: Record<string, string>, open = true) {
    const openPromises: Array<Promise<Pager>> = [];

    for (const name in pagers) if (pagers[name]) {
      openPromises.push(this.setPager(name, pagers[name], open));
    }

    if (open) {
      await Promise.all(openPromises);
    }
  }

  async getPage(table: string, index: number) {
    const frame = await this.bufferPool.getFrame(table, index);
    const manager = frame && this.pageManager.setTarget(frame.buffer, frame);
    if (!manager) {
      throw new AppError('PAGE_NOT_FOUND', { pageId: index, table });
    }
    return manager;
  }

//   async *iterate(table: string) {
//     const totalPages = this.bufferPool.getTotalPages(table);
// 
//     for (let index = 0 ; index < totalPages ; ++index) {
//       const pageManager = await this.getPage(table, index);
//       yield { pageManager, id: index };
//     }
//   }

  async allocatePage(table: string, pageType: PageType = PAGE_TYPE.TREE_LEAF) {
    const pager = this.getPager(table);
    const newPageId = await pager.allocatePage();
    const pageManager = await this.getPage(table, newPageId);

    pageManager.init(pageType);

    return { pageManager, id: newPageId };
  }

  getTotalPages(table: string) {
    return this.bufferPool.getTotalPages(table);
  }

  flush() {
    return this.bufferPool.flushAll();
  };

  getPager(table: string) {
    const pager = this.pagers[table];

    if (!pager) {
      throw new AppError('TABLE_NOT_FOUND', { table });
    }

    return pager;
  }

  async open(table: string) {
    if (this.openPagers[table]) {
      return this.openPagers[table];
    }

    const pager = this.getPager(table);

    return (this.openPagers[table] = await pager.open());
  }

  async closeAll() {
    const promises: Array<Promise<void>> = [];
    for (const name in this.openPagers) if (this.openPagers[name]) {
      promises.push(this.openPagers[name].close());
    }
    await Promise.all(promises);
    this.openPagers = {};
  }

  // PLACEHOLDER
  async updateRootPageId(table: string, id: number) {
    console.log(table, id);
  }
}
