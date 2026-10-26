import { PagePool } from './page-pool';
import { deserializeRow, serializeRow } from '../utils/buffer-utils';
import { PAGE_TYPE } from '../constants';
import { IndexTreeManager } from './index-tree-manager';

type FieldValue = Buffer | null;
type TableInsertResult = { pageId: number; slotIndex: number };

export type SplitResult = {
  splitKey: Buffer | null;      // The new signpost key to push up into the parent router node
  leftChildId: number;   // The original page ID containing the lower-bound values
  rightChildId: number;  // The new page ID containing the upper-bound values
}

export class TableAccessor {
  private tableName: string;
  private pagerPool: PagePool;
  private rootId = 0;
  private treeManager: IndexTreeManager;

  constructor(tableName: string, pagePool: PagePool) {
    this.tableName = tableName;
    this.pagerPool = pagePool;
    this.treeManager = new IndexTreeManager(tableName, pagePool);
  }

  /**
   * Inserts an array of raw fields into the first available leaf page of the table.
   * Automatically handles allocating a new page if an overflow occurs.
   */
  async insert(fields: FieldValue[]): Promise<TableInsertResult> {
    const serializedRecord = serializeRow(fields);
    const insertResult = await this.treeManager.insertIndexed(this.rootId, serializedRecord);
    if (insertResult.newRootId > -1) {
      await this.setRootId(insertResult.newRootId);
    }
    return { pageId: insertResult.pageId, slotIndex: insertResult.slotId };
  }

  /**
   * Extracts a specific record from the table by its physical address coordinates.
   */
  async get(pageId: number, slotIndex: number): Promise<FieldValue[] | null> {
    const page = await this.pagerPool.getPage(this.tableName, pageId);
    const row = page?.getRow(slotIndex) || null;

    return row && deserializeRow(row);
  }

  /**
   * Deletes a record at specific coordinates.
   */
  async delete(pageId: number, slotIndex: number): Promise<boolean> {
    const page = await this.pagerPool.getPage(this.tableName, pageId);
    const result = page?.deleteRow(slotIndex) || false;

    return result;
  }

  async getRawPage(index: number) {
    return (await this.pagerPool.getPage(this.tableName, index))?.getBuffer();
  }

  async init() {
    if (this.pagerPool.getTotalPages(this.tableName) === 0) {
      const { pageManager } = await this.pagerPool.allocatePage(this.tableName, PAGE_TYPE.META);
      pageManager.setNextPageId(1);
      const { id } = await this.pagerPool.allocatePage(this.tableName, PAGE_TYPE.TREE_LEAF);
      this.rootId = id;
    } else {
      const pageManager = await this.pagerPool.getPage(this.tableName, 0);
      this.rootId = pageManager.getNextPageId();
    }
  }

  async setRootId(pageId: number) {
    const pageManager = await this.pagerPool.getPage(this.tableName, 0);
    pageManager.setNextPageId(this.rootId = pageId);
    return pageId;
  }

  async getRootNode() {
    return this.rootId;
  }
}
