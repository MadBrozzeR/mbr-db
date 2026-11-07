import { DEFAULT_MAX_TREE_DEPTH, DEFAULT_PRIMARY_KEY_SIZE, INSERT_STRATEGY, PAGE_TYPE } from '../constants';
import { bufferIncremented, cloneBuffer, deserializeRow, getChildId, getKeyFromRow, isNextKeyValue } from '../utils/buffer-utils';
import { AppError } from '../utils/errors';
import { Stack } from '../utils/stack';
import { PageManager } from './page-manager';
import { PagePool } from './page-pool';

export type SplitResult = {
  splitKey: Buffer;       // The new signpost key to push up into the parent router node
  leftChildId: number;    // The original page ID containing the lower-bound values
  rightChildId: number;   // The new page ID containing the upper-bound values
  insertedPageId: number; // Page ID where row were inserted
  insertedSlotId: number; // Slot ID of inserted record
}

export class IndexTreeManager {
  private tableName: string;
  private pagerPool: PagePool;

  constructor(tableName: string, pagerPool: PagePool) {
    this.tableName = tableName;
    this.pagerPool = pagerPool;
  }

  async findRoute(rootPageId: number, key: Buffer) {
    const result = new Stack<number>();

    for await (const state of this.lookup(rootPageId)) {
      result.push(state.current);
      if (result.isLongerThen(DEFAULT_MAX_TREE_DEPTH)) {
        throw new AppError('TREE_DEPTH_EXCEEDED', { depth: DEFAULT_MAX_TREE_DEPTH });
      }
      if (state.page.getPageType() === PAGE_TYPE.TREE_INTERNAL) {
        state.next = state.page.routeToChildPage(key);
      }
    }

    return result;
  }

  /**
   * Core high-speed transactional insert workflow supporting allocation-free
   * traversal paths and recursive bottom-up internal node split propagation.
   */
  async insertIndexed(
    rootPageId: number,
    rowBuffer: Buffer,
    key?: Buffer,
    strategy: number = INSERT_STRATEGY.INSERT
  ) {
    const targetKey = key || getKeyFromRow(rowBuffer);

    const traversalStack = await this.findRoute(rootPageId, targetKey);

    const result = {
      key: targetKey,
      pageId: -1,
      slotId: -1,
      newRootId: -1,
    };

    let currentInsertionKey = targetKey;
    let currentDataToInsert = rowBuffer;
    let leftPageId = -1;

    if (strategy === INSERT_STRATEGY.INSERT || strategy === INSERT_STRATEGY.UPDATE) {
      const page = await this.fetchPage(traversalStack.last() || -1);
      const search = page.findSlotByKey(targetKey);
      if (strategy === INSERT_STRATEGY.INSERT && search > -1) {
        throw new AppError('DUPLICATE_RECORD_ID', { id: `<${targetKey.toString('hex')}>` });
      }
      if (strategy === INSERT_STRATEGY.UPDATE && search === -1) throw new AppError('RECORD_NOT_FOUND');
    }

    for (const pageId of traversalStack) {
      const splitResult = await this.insertOrSplit(pageId, currentDataToInsert, currentInsertionKey);
      if (splitResult.pageType === PAGE_TYPE.TREE_LEAF) {
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
    const pageType = pageManager.getPageType();
    // const type = pageManager.getPageType();
    try {
      const slotId = pageManager.insertRowOrSortingKey(rowBuffer, key, pageType);
      return { slotId, pageId, pageType };
    } catch (error) {
      if (AppError.checkReason(error, 'PAGE_OUT_OF_SPACE')) {
        const splitResult = await this.splitPage(pageId, rowBuffer, key);

        return {
          splitKey: splitResult.splitKey,
          leftChildId: splitResult.leftChildId,
          rightChildId: splitResult.rightChildId,
          slotId: splitResult.insertedSlotId,
          pageId: splitResult.insertedPageId,
          pageType,
        };
      }

      throw error;
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
  private async splitPage(pageId: number, rowBuffer: Buffer, key: Buffer): Promise<SplitResult> {
    const leftPage = (await this.fetchPage(pageId)).clone();
    const pageType = leftPage.getPageType();

    const { pageManager: newPage, id: newPageId } = await this.pagerPool.allocatePage(this.tableName);
    newPage.init(pageType);

    const lastKey = leftPage.getLastKey();
    if (!lastKey) throw new AppError('RECORD_NOT_FOUND');

    if (pageType === PAGE_TYPE.TREE_LEAF && isNextKeyValue(key, lastKey)) {
      const rightPageId = leftPage.getNextPageId();
      leftPage.setNextPageId(newPageId);
      newPage.setNextPageId(rightPageId);
      const insertedSlotId = newPage.insertRow(rowBuffer);
      return { splitKey: key, leftChildId: pageId, rightChildId: newPageId, insertedPageId: newPageId, insertedSlotId };
    }

    const middleIndex = leftPage.findMiddleSlotIndex();

    if (middleIndex === 0) {
      if (pageType === PAGE_TYPE.TREE_LEAF) {
        const insertedSlotId = newPage.insertRow(rowBuffer);
        newPage.setNextPageId(leftPage.getNextPageId());
        leftPage.setNextPageId(newPageId);
        return {
          splitKey: key, leftChildId: pageId, rightChildId: newPageId, insertedPageId: newPageId, insertedSlotId,
        };
      } else {
        throw new AppError('CANNOT_SPLIT_INTERNAL');
      }
    }

    const middleRow = leftPage.getRow(middleIndex);
    if (!middleRow) throw new AppError('RECORD_NOT_FOUND');
    const middleRowData = deserializeRow(middleRow, 2);
    if (!middleRowData[0] || !middleRowData[1]) throw new AppError('FIELD_NOT_FOUND');
    const splitKey = cloneBuffer(middleRowData[0]);

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
    let insertedPageId: number;
    let insertedSlotId: number;

    if (key.compare(splitKey) === -1) {
      insertedPageId = pageId;
      insertedSlotId = leftPage.insertRowOrSortingKey(rowBuffer, key, pageType);
    } else {
      insertedPageId = newPageId;
      insertedSlotId = newPage.insertRowOrSortingKey(rowBuffer, key, pageType);
    }

    return {
      splitKey,
      leftChildId: pageId,
      rightChildId: newPageId,
      insertedPageId,
      insertedSlotId,
    };
  }

  async getFirstLeaf(rootId: number) {
    for await (const state of this.lookup(rootId)) {
      switch (state.page.getPageType()) {
        case PAGE_TYPE.TREE_INTERNAL:
          state.next = state.page.getNextPageId();
          break;
        case PAGE_TYPE.TREE_LEAF:
          return state.current;
      }
    }
    throw new AppError('PAGE_NOT_FOUND_1');
  }

  async *iteratePages(rootId: number) {
    const firstLeaf = await this.getFirstLeaf(rootId);
    for await (const state of this.lookup(firstLeaf)) {
      const nextPage = state.page.getNextPageId();
      if (nextPage > 0) {
        state.next = nextPage;
      }
      yield state.page;
    }
  }

  async *iterateRows(rootId: number, startKey?: Buffer) {
    const firstLeaf = await this.getFirstLeaf(rootId);
    let startSlotId = startKey ? this.pagerPool.pageManager.findSlotByKey(startKey) : 0;
    for await (const page of this.iteratePages(firstLeaf)) {
      for (const slot of page.iterateSlots(startSlotId)) {
        yield slot.getRow();
      }
      startSlotId = 0;
    }
  }

  async searchLastKey(rootId: number) {
    let currentManager = await this.fetchPage(rootId)
    while (currentManager.getPageType() === PAGE_TYPE.TREE_INTERNAL) {
      const lastRow = currentManager.getLastRow();
      if (!lastRow) {
        throw new AppError('RECORD_NOT_FOUND');
      }
      const lastPageReference = deserializeRow(lastRow, 2)[1];
      if (!lastPageReference) {
        throw new AppError('RECORD_NOT_FOUND');
      }
      if (lastPageReference.length < 4) {
        throw new AppError('WRONG_FIELD_SIZE', { size: lastPageReference.length, required: 4 });
      }

      const nextPageId = lastPageReference.readUInt32BE(0);
      currentManager = await this.fetchPage(nextPageId);
    }
    if (currentManager.getPageType() === PAGE_TYPE.TREE_LEAF) {
      const lastRow = currentManager.getLastRow();

      if (!lastRow) {
        return null;
      }

      const key = deserializeRow(lastRow, 1)[0];

      if (!key) {
        throw new AppError('KEY_NOT_FOUND');
      }

      return key;
    }
    throw new AppError('PAGE_TYPE_UNHANDLED');
  }

  async getNextKey(rootId: number) {
    const lastKey = await this.searchLastKey(rootId);
    if (!lastKey) {
      return Buffer.alloc(DEFAULT_PRIMARY_KEY_SIZE);
    }
    return bufferIncremented(lastKey);
  }

  async *lookup(rootId: number) {
    const state = {
      next: rootId,
      current: -1,
      page: this.pagerPool.pageManager,
    }

    while (state.next > -1) {
      await this.fetchPage(state.next);
      state.current = state.next;
      state.next = -1
      yield state;
    }
  }
}
