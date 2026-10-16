import { deserializeRow, serializeRow } from '../utils/buffer-utils';
import { PagePool } from './page-pool';

type FieldValue = Buffer | null;
type TableInsertResult = { pageId: number; slotIndex: number };

export class TableAccessor {
  private tableName: string;
  private pagerPool: PagePool;

  constructor(tableName: string, pagePool: PagePool) {
    this.tableName = tableName;
    this.pagerPool = pagePool;
  }

  /**
   * Inserts an array of raw fields into the first available leaf page of the table.
   * Automatically handles allocating a new page if an overflow occurs.
   */
  async insert(fields: FieldValue[]): Promise<TableInsertResult> {
    const serializedRecord = serializeRow(fields);
    const recordSize = serializedRecord.length;
    let slotIndex = -1;
    let pageId = -1;

    for await (const { pageManager, id } of this.pagerPool.iterate(this.tableName)) {
      if (pageManager.checkSpaceIsAvailable(recordSize)) {
        slotIndex = pageManager.insertRow(serializedRecord);
        pageId = id;
        break;
      }
    }

    if (slotIndex < 0) {
      const { pageManager, id } = await this.pagerPool.allocatePage(this.tableName);
      slotIndex = pageManager.insertRow(serializedRecord);
      pageId = id;
    }

    return { pageId, slotIndex };
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
}
