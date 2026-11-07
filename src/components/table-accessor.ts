import { PagePool } from './page-pool';
import { BufferReader, deserializeRow, serializeRow } from '../utils/buffer-utils';
import { INSERT_STRATEGY, PAGE_TYPE } from '../constants';
import { IndexTreeManager } from './index-tree-manager';
import { AppError } from '../utils/errors';

type FieldValue = Buffer | null;
type TableInsertResult = { pageId: number; slotIndex: number };

export type SplitResult = {
  splitKey: Buffer | null;      // The new signpost key to push up into the parent router node
  leftChildId: number;   // The original page ID containing the lower-bound values
  rightChildId: number;  // The new page ID containing the upper-bound values
}

function createIndexRootReference(indexId: number, pageId: number) {
  const buffer = Buffer.from('8200008400000000', 'hex');
  if (indexId) {
    buffer.writeUInt16BE(indexId, 1);
  }
  buffer.writeUInt32BE(pageId, 4);
  return buffer;
}

export class TableAccessor {
  private tableName: string;
  private pagerPool: PagePool;
  private treeManager: IndexTreeManager;
  private indexRoot = new Map<number | bigint, number | bigint>();

  constructor(tableName: string, pagePool: PagePool) {
    this.tableName = tableName;
    this.pagerPool = pagePool;
    this.treeManager = new IndexTreeManager(tableName, pagePool);
  }

  /**
   * Inserts an array of raw fields into the first available leaf page of the table.
   * Automatically handles allocating a new page if an overflow occurs.
   */
  async insert(fields: FieldValue[], key?: Buffer): Promise<TableInsertResult> {
    const rootId = this.getIndexRootId(0);
    const firstField = key || await this.treeManager.getNextKey(rootId);
    const targetFields: FieldValue[] = [firstField, ...fields];
    const serializedRecord = serializeRow(targetFields);
    const insertResult = await this.treeManager.insertIndexed(rootId, serializedRecord, firstField);
    if (insertResult.newRootId > -1) {
      await this.setIndexRootId(0, insertResult.newRootId);
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
      await this.pagerPool.allocatePage(this.tableName, PAGE_TYPE.META); // create Header Page (0)
      this.pagerPool.pageManager.setNextPageId(1);
      await this.pagerPool.allocatePage(this.tableName, PAGE_TYPE.TREE_LEAF); // create Index Dictionary (1)
      this.pagerPool.pageManager.insertRow(createIndexRootReference(0, 2));
      this.indexRoot.set(0, 2);
      await this.pagerPool.allocatePage(this.tableName, PAGE_TYPE.TREE_LEAF); // create first Clustered Data page (2)
    } else {
      const reader = new BufferReader();
      const pageManager = await this.pagerPool.getPage(this.tableName, 0);
      const dictionaryRoot = pageManager.getNextPageId();
      for await (const row of this.treeManager.iterateRows(dictionaryRoot)) {
        if (!row) continue;
        reader.set(row);
        const keyIndex = reader.readRowFieldAsInt();
        const reference = reader.readRowFieldAsInt();
        this.indexRoot.set(keyIndex, reference);
      }
    }
  }

  async setIndexRootId(indexId: number, pageId: number) {
    const pageManager = this.pagerPool.pageManager;
    await this.pagerPool.getPage(this.tableName, 0);
    const currentIndexRoot = pageManager.getNextPageId();
    await this.pagerPool.getPage(this.tableName, currentIndexRoot);
    const indexRow = createIndexRootReference(indexId, pageId);
    const insertOrUpdateFlag = INSERT_STRATEGY.INSERT | INSERT_STRATEGY.UPDATE;
    const insertResult = await this.treeManager.insertIndexed(currentIndexRoot, indexRow, undefined, insertOrUpdateFlag);
    if (insertResult.newRootId > -1) {
      await this.pagerPool.getPage(this.tableName, 0);
      pageManager.setNextPageId(insertResult.newRootId);
    }
    this.indexRoot.set(indexId, pageId);
    return pageId;
  }

  getIndexRootId(indexId: number) {
    const reference = this.indexRoot.get(indexId);
    if (!reference) {
      throw new AppError('INDEX_NOT_FOUND', { index: indexId });
    }

    return Number(reference);
  }
}
