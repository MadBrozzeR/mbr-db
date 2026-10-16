import { PAGE_TYPE } from '../constants';
import { BufferPool } from './buffer-pool';
import { ControlledError } from './errors';
import { PageManager } from './page-manager';
import { Pager } from './pager';

const DEFAULT_POOL_COUNT = 20;

export class PagePool {
  bufferPool: BufferPool;
  pagers: Record<string, Pager> = {};

  constructor(number = DEFAULT_POOL_COUNT) {
    this.bufferPool = new BufferPool(number);
  }

  async setPagers(pagers: Record<string, string>, open = true) {
    const openPromises: Array<Promise<Pager>> = [];

    for (const name in pagers) if (pagers[name]) {
      const pager = new Pager(pagers[name]);
      this.pagers[name] = pager;
      this.bufferPool.addPager(name, pager);
      open && openPromises.push(pager.open());
    }

    if (openPromises.length) {
      await Promise.all(openPromises);
    }
  }

  async getPage(table: string, index: number) {
    const frame = await this.bufferPool.getFrame(table, index);
    return frame && new PageManager(frame.buffer, frame);
  }

  async *iterate(table: string) {
    const totalPages = this.bufferPool.getTotalPages(table);

    for (let index = 0 ; index < totalPages ; ++index) {
      const pageManager = await this.getPage(table, index);
      if (pageManager) {
        yield { pageManager, id: index };
      }
    }
  }

  async allocatePage(table: string) {
    const pager = this.pagers[table];
    if (!pager) {
      throw new ControlledError('TABLE_NOT_FOUND');
    }
    const lastPageIndex = pager.getTotalPages() - 1;
    const lastPage = lastPageIndex < 0 ? null : await this.getPage(table, lastPageIndex);
    const newPageId = await pager.allocatePage();
    const pageManager = await this.getPage(table, newPageId);

    if (!pageManager) {
      throw new ControlledError('PAGE_WAS_NOT_CREATED');
    }

    pageManager.init(PAGE_TYPE.TREE_LEAF);

    if (lastPage) {
      lastPage.setNextPageId(newPageId);
    }

    return { pageManager, id: newPageId };
  }

  getTotalPages(table: string) {
    return this.bufferPool.getTotalPages(table);
  }
}
