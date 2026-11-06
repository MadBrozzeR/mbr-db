import { Pager } from './pager';
import { AppError } from '../utils/errors';
import { DEFAULT_POOL_COUNT, SIZE } from '../constants';
import { BufferReader } from '../utils/buffer-utils';

export type CacheFrame = {
  table: string;
  pageId: number;
  buffer: Buffer;
  isDirty: boolean; // True if memory changed but hasn't been written to disk yet
}

export class BufferPool {
  private pagers = new Map<string, Pager>();
  private maxPages: number;
  private pool = new Map<string, CacheFrame>();
  private globalBuffer: BufferReader;

  static EMPTY: CacheFrame = {
    table: '',
    pageId: -1,
    buffer: Buffer.alloc(0),
    isDirty: false,
  };

  constructor(maxPages: number = DEFAULT_POOL_COUNT) {
    this.maxPages = maxPages;
    this.globalBuffer = new BufferReader(Buffer.alloc(maxPages * SIZE.PAGE));
  }

  /**
   * Generates a unique tracking key for the memory map cache.
   */
  private makeKey(table: string, pageId: number): string {
    return `${table}:${pageId}`;
  }

  addPager(table: string, pager: Pager) {
    this.pagers.set(table, pager);
  }

  /**
   * Retrieves a page buffer. Uses cache if available, otherwise reads from disk.
   */
  async getPage(table: string, pageId: number): Promise<Buffer | null> {
    const frame = await this.getFrame(table, pageId);
    return frame?.buffer || null;
  }

  async getFrame(table: string, pageId: number): Promise<CacheFrame | null> {
    const cacheKey = this.makeKey(table, pageId);

    // Cache Hit
    if (this.pool.has(cacheKey)) {
      const frame = this.pool.get(cacheKey)!;
      // Refresh LRU order by deleting and re-inserting
      this.pool.delete(cacheKey);
      this.pool.set(cacheKey, frame);
      return frame;
    }

    const pager = this.pagers.get(table);
    if (!pager) {
      throw new Error(`No active table pager found for table: ${table}`);
    }

    if (pageId >= pager.getTotalPages()) {
      return null;
    }

    const frame = (this.pool.size >= this.maxPages)
      ? await this.reuseOldestFrame(table, pageId)
      : {
        buffer: this.globalBuffer.readData(SIZE.PAGE),
        table,
        pageId,
        isDirty: false,
      };

    // Read from physical disk via Pager
    await pager.readPage(pageId, frame.buffer);

    this.pool.set(cacheKey, frame);

    return frame;
  }

  /**
   * Marks a page buffer as modified (dirty) so we know it needs flushing later
   */
  markDirty(table: string, pageId: number): void {
    const frame = this.retrieveFrame(table, pageId);
    if (frame) {
      frame.isDirty = true;
    }
  }

  retrieveFrame(table: string, pageId: number) {
    const cacheKey = this.makeKey(table, pageId);
    return this.pool.get(cacheKey);
  }

  /**
   * Flushes all dirty pages currently sitting in RAM back to disk
   */
  async flushAll(): Promise<void> {
    for (const frame of this.pool.values()) {
      if (frame.isDirty) {
        const pager = this.pagers.get(frame.table);
        pager && await pager.writePage(frame.pageId, frame.buffer);
        frame.isDirty = false;
      }
    }
  }

  async reuseOldestFrame(table: string, pageId: number) {
    const oldestKey = this.pool.keys().next().value;
    if (oldestKey === undefined) {
      throw new AppError('NO_BUFFER_POOL_KEY');
    };

    const frame = this.pool.get(oldestKey)!;

    // Critically important: If it was changed, save it to disk before forgetting it!
    if (frame.isDirty) {
      const pager = this.pagers.get(frame.table);
      pager && await pager.writePage(frame.pageId, frame.buffer);
    }

    frame.table = table;
    frame.pageId = pageId;
    frame.isDirty = false;

    this.pool.delete(oldestKey);
    return frame;
  }

  /**
   * Evicts the least recently used page from RAM
   */
  /*
  private async evictOne(): Promise<void> {
    // The first item in a Map iterator is the oldest inserted/accessed item
    const oldestKey = this.pool.keys().next().value;
    if (oldestKey === undefined) return;

    const frame = this.pool.get(oldestKey)!;

    // Critically important: If it was changed, save it to disk before forgetting it!
    if (frame.isDirty) {
      const pager = this.pagers.get(frame.table);
      pager && await pager.writePage(frame.pageId, frame.buffer);
    }

    this.pool.delete(oldestKey);
  }
  */

  getTotalPages(table: string) {
    const pager = this.pagers.get(table);
    if (!pager) {
      throw new AppError('TABLE_NOT_FOUND');
    }
    return pager.getTotalPages();
  }
}
