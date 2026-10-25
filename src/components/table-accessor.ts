import { PagePool } from './page-pool';
import { deserializeRow, serializeRow } from '../utils/buffer-utils';
import { AppError } from '../utils/errors';
import { PAGE_TYPE } from '../constants';

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
        slotIndex = pageManager.insertSortedRow(serializedRecord);
        pageId = id;
        break;
      }
    }

    if (slotIndex < 0) {
      const { pageManager, id } = await this.pagerPool.allocatePage(this.tableName);
      slotIndex = pageManager.insertSortedRow(serializedRecord);
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

  async getRawPage(index: number) {
    return (await this.pagerPool.getPage(this.tableName, index))?.getBuffer();
  }

  /**
   * Safe-wrapper insertion interface that intercepts out-of-space issues 
   * and automatically coordinates structural page splits.
   */
  async insertIndexed(_rowBuffer: Buffer, _rootPageId = 0): Promise<SplitResult | null> {
    // This high-level coordination path will be refined when building the full IndexTreeManager tree traversal.
    // For now, let's construct the core structural page-splitting mechanics directly.
    return null;
  }

  /**
   * Splits a saturated leaf page down the middle, balancing the contents 
   * across a brand new right sibling page.
   */
  async splitPage(pageId: number): Promise<SplitResult> {
    const leftPage = (await this.pagerPool.getPage(this.tableName, pageId))?.clone();
    if (!leftPage) {
      throw new AppError('PAGE_NOT_FOUND', { pageId, table: this.tableName });
    }
    const pageType = leftPage.getPageType();

    const { pageManager: newPage, id: newPageId } = await this.pagerPool.allocatePage(this.tableName);
    newPage.init(pageType);

    const middleIndex = leftPage.findMiddleSlotIndex();

    // handle case with 0 or 1 slots
    if (middleIndex === 0) {
      if (pageType === PAGE_TYPE.TREE_LEAF) {
        newPage.setNextPageId(leftPage.getNextPageId());
        leftPage.setNextPageId(newPageId);
        return { splitKey: null, leftChildId: pageId, rightChildId: newPageId };
      } else {
        throw new AppError('CANNOT_SPLIT_INTERNAL');
      }
    }

    const middleRow = leftPage.getRow(middleIndex);
    if (!middleRow) {
      throw new AppError('RECORD_NOT_FOUND');
    }
    const middleRowData = deserializeRow(middleRow, 2);
    if (!middleRowData[0] || !middleRowData[1]) {
      throw new AppError('FIELD_NOT_FOUND');
    }
    const splitKey = middleRowData[0];

    leftPage.deleteRow(middleIndex);
    if (pageType === PAGE_TYPE.TREE_LEAF) {
      const rightPageId = leftPage.getNextPageId();
      leftPage.setNextPageId(newPageId);
      newPage.setNextPageId(rightPageId);
      newPage.insertRow(middleRow);
    } else {
      newPage.setLeftmostChildId(middleRowData[1]);
    }
    for (const slotInfo of leftPage.iterateSlots(middleIndex + 1)) {
      const row = slotInfo.getRow();
      if (!row) {
        continue;
      }
      newPage.insertRow(row);
      leftPage.deleteRow(slotInfo.index);
    }

    // Clear structural fragmentation inside the left page layout immediately
    leftPage.defragment();

    return {
      splitKey,
      leftChildId: pageId,
      rightChildId: newPageId
    };
  }
}
