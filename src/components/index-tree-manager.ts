import { DEFAULT_MAX_TREE_DEPTH, PAGE_TYPE } from '../constants';
import { deserializeRow, getChildId, getKeyFromRow } from '../utils/buffer-utils';
import { AppError } from '../utils/errors';
import { PageManager } from './page-manager';
import { PagePool } from './page-pool';

export type SplitResult = {
  splitKey: Buffer | null;      // The new signpost key to push up into the parent router node
  leftChildId: number;   // The original page ID containing the lower-bound values
  rightChildId: number;  // The new page ID containing the upper-bound values
}

export class IndexTreeManager {
  private tableName: string;
  private pagerPool: PagePool;

  constructor(tableName: string, pagerPool: PagePool) {
    this.tableName = tableName;
    this.pagerPool = pagerPool;
  }

  /**
   * Core high-speed transactional insert workflow supporting allocation-free
   * traversal paths and recursive bottom-up internal node split propagation.
   */
  async insertIndexed(rootPageId: number, rowBuffer: Buffer) {
    const traversalStack: number[] = [];
    let currentPageId = rootPageId;
    let currentManager = await this.fetchPage(currentPageId);

    const targetKey = getKeyFromRow(rowBuffer);

    const result = {
      key: targetKey,
      pageId: -1,
      slotId: -1,
      newRootId: -1,
    };

    // PHASE 7: TREE TRAVERSAL MOTOR
    // Navigate down the index topology until a structural data leaf node is located.
    while (currentManager.getPageType() === PAGE_TYPE.TREE_INTERNAL) {
      traversalStack.push(currentPageId);
      if (traversalStack.length > DEFAULT_MAX_TREE_DEPTH) {
        throw new AppError('TREE_DEPTH_EXCEEDED', { depth: DEFAULT_MAX_TREE_DEPTH });
      }
      currentPageId = currentManager.routeToChildPage(targetKey);
      currentManager = await this.fetchPage(currentPageId);
    }
    traversalStack.push(currentPageId);

    let currentInsertionKey = targetKey;
    let currentDataToInsert = rowBuffer;
    let leftPageId = -1;

    for (let index = traversalStack.length - 1 ; index >= 0 ; --index) {
      const localPageId = traversalStack[index];
      if (localPageId === undefined) {
        continue;
      }
      const splitResult = await this.insertOrSplit(localPageId, currentDataToInsert, currentInsertionKey);
      if (result.pageId < 0 && result.slotId < 0) {
        result.slotId = splitResult.slotId;
        result.pageId = splitResult.pageId;
      }
      if (!splitResult.splitKey) return result;

      currentInsertionKey = splitResult.splitKey;
      currentDataToInsert = getChildId(splitResult.rightChildId);
      leftPageId = splitResult.leftChildId;
    }

    result.newRootId = await this.createNewRoot(leftPageId, currentInsertionKey, currentDataToInsert);

    return result;
  }

  async insertOrSplit(pageId: number, rowBuffer: Buffer, key: Buffer) {
    const pageManager = await this.fetchPage(pageId);
    // const type = pageManager.getPageType();
    try {
      const slotId = pageManager.insertRowOrSortingKey(rowBuffer, key);
      return { slotId, pageId };
    } catch (error) {
      if (AppError.checkReason(error, 'PAGE_OUT_OF_SPACE')) {
        let targetPageId: number;
        const splitResult = await this.splitPage(pageId);
        const pageManager = await (
          !splitResult.splitKey || key.compare(splitResult.splitKey) > -1
            ? this.fetchPage(targetPageId = splitResult.rightChildId)
            : this.fetchPage(targetPageId = splitResult.leftChildId)
          );

        const slotId = pageManager.insertRowOrSortingKey(rowBuffer, key);

        return {
          splitKey: splitResult.splitKey || key,
          leftChildId: splitResult.leftChildId,
          rightChildId: splitResult.rightChildId,
          slotId,
          pageId: targetPageId,
        };
      } else {
        throw error;
      }
    }
  }

  /**
   * Generates a new root node when a split cascades all the way to the top.
   */
  private async createNewRoot(leftChildId: number, routingKey: Buffer, rightChildId: number | Buffer): Promise<number> {
    const { pageManager: newRoot , id: newRootId } = await this.pagerPool.allocatePage(this.tableName);
    newRoot.init(PAGE_TYPE.TREE_INTERNAL);

    // Wire the initial routing layout for the new internal root node
    newRoot.setLeftmostChildId(leftChildId);
    newRoot.insertRoutingKey(routingKey, rightChildId);

    // Update the engine state directory mapping
    return newRootId;
  }

  /**
   * Internal proxy to load pages safely from the pool.
   */
  private async fetchPage(pageId: number): Promise<PageManager> {
    const manager = await this.pagerPool.getPage(this.tableName, pageId);
    if (!manager) {
      throw new AppError('PAGE_NOT_FOUND', { pageId, table: this.tableName });
    }
    return manager;
  }

  /**
   * Copy of the engine's page-splitting routine.
   */
  private async splitPage(pageId: number): Promise<SplitResult> {
    const leftPage = (await this.pagerPool.getPage(this.tableName, pageId))?.clone();
    if (!leftPage) {
      throw new AppError('PAGE_NOT_FOUND', { pageId, table: this.tableName });
    }
    const pageType = leftPage.getPageType();

    const { pageManager: newPage, id: newPageId } = await this.pagerPool.allocatePage(this.tableName);
    newPage.init(pageType);

    const middleIndex = leftPage.findMiddleSlotIndex();

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
    if (!middleRow) throw new AppError('RECORD_NOT_FOUND');
    const middleRowData = deserializeRow(middleRow, 2);
    if (!middleRowData[0] || !middleRowData[1]) throw new AppError('FIELD_NOT_FOUND');
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
      if (!row) continue;
      newPage.insertRow(row);
      leftPage.deleteRow(slotInfo.index);
    }

    leftPage.defragment();

    return {
      splitKey,
      leftChildId: pageId,
      rightChildId: newPageId
    };
  }
}
