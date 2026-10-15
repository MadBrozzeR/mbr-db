import { serializeRow } from '../utils/buffer-utils';
import { BufferPool } from './buffer-pool';
import { PageManager } from './page-manager';
import { Pager } from './pager';

export class TreeBalancer {
  private pager: Pager;
  private bufferPool: BufferPool;
  private table: string;

  constructor(table: string, pager: Pager, bufferPool: BufferPool) {
    this.pager = pager;
    this.bufferPool = bufferPool;
    this.table = table;
  }

  /**
   * Splits a full leaf page into two balanced sibling pages.
   * Returns the new right page ID and the boundary key that must be pushed up to the parent.
   */
  async splitLeafPage(leftPageId: number, pendingFields: Array<Buffer | null>): Promise<{ rightPageId: number; boundaryKey: Buffer }> {
    // 1. Fetch the overloaded left page buffer from memory
    const leftBuffer = await this.bufferPool.getPage(this.table, leftPageId);
    const leftManager = new PageManager(leftBuffer);
    const totalSlots = leftManager.getSlotCount();

    // 2. Gather all existing valid rows out of the left page
    const temporaryRowCollection: Buffer[] = [];
    for (let index = 0; index < totalSlots; ++index) {
      const activeRow = leftManager.getRow(index);
      if (activeRow !== null) {
        // We make a safe standalone memory copy since getRow returns a direct subarray view
        temporaryRowCollection.push(Buffer.from(activeRow));
      }
    }

    // 3. Serialize and add our pending row that triggered the overflow
    temporaryRowCollection.push(serializeRow(pendingFields));

    // Note: In a fully complete index engine, you would sort temporaryRowCollection 
    // by key byte order here before distribution. We will attach the sorting pass later.

    // 4. Allocate a brand new page frame on disk to act as our right sibling
    const rightPageId = await this.pager.allocatePage();
    const rightBuffer = await this.bufferPool.getPage(this.table, rightPageId);
    const rightManager = new PageManager(rightBuffer);

    // Initialize the right page, inheriting the left page's original sibling chain
    rightManager.init(leftManager.getPageType(), leftManager.getNextPageId());

    // 5. Clear out the left page layout completely to overwrite it evenly
    const originalPageType = leftManager.getPageType();
    leftManager.init(originalPageType, rightPageId);

    // 6. Distribute the records 50/50 across the two clean page horizons
    const splitPointIndex = Math.floor(temporaryRowCollection.length / 2);

    for (let index = 0; index < temporaryRowCollection.length; ++index) {
      const activePayload = temporaryRowCollection[index];

      if (activePayload) {
        if (index < splitPointIndex) {
          leftManager.insertRow(activePayload);
        } else {
          rightManager.insertRow(activePayload);
        }
      }
    }

    // 7. Extract our separation boundary key to report back to the parent router.
    // The very first record in the right page dictates the lowest bound of that subtree.
    const firstRightRow = rightManager.getRow(0);
    if (firstRightRow === null) {
      throw new Error("Catastrophic tree balancing failure: Right split node is empty.");
    }

    // Mark both pages as dirty in memory so the Buffer Pool flushes them to disk
    this.bufferPool.markDirty(this.table, leftPageId);
    this.bufferPool.markDirty(this.table, rightPageId);

    return {
      rightPageId,
      boundaryKey: firstRightRow // Returning the raw row prefix as our pivot key
    };
  }
}
