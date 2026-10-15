import { Pager } from './pager';

export interface CacheFrame {
  table: string;
  pageId: number;
  buffer: Buffer;
  isDirty: boolean; // True if memory changed but hasn't been written to disk yet
}

export class BufferPool {
  private pagers = new Map<string, Pager>();
  private maxPages: number;
  private pool: Map<string, CacheFrame> = new Map();

  constructor(maxPages: number = 20) {
    this.maxPages = maxPages;
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
  async getPage(table: string, pageId: number): Promise<Buffer> {
    const cacheKey = this.makeKey(table, pageId);

    // Cache Hit
    if (this.pool.has(cacheKey)) {
      const frame = this.pool.get(cacheKey)!;
      // Refresh LRU order by deleting and re-inserting
      this.pool.delete(cacheKey);
      this.pool.set(cacheKey, frame);
      return frame.buffer;
    }

    // Cache Miss -> Evict oldest page if pool is full
    if (this.pool.size >= this.maxPages) {
      await this.evictOne();
    }

    const pager = this.pagers.get(table);
    if (!pager) {
      throw new Error(`No active table pager found for table: ${table}`);
    }

    // Read from physical disk via Pager
    const buffer = await pager.readPage(pageId);

    this.pool.set(cacheKey, {
      table,
      pageId,
      buffer,
      isDirty: false,
    });

    return buffer;
  }

  /**
   * Marks a page buffer as modified (dirty) so we know it needs flushing later
   */
  markDirty(table: string, pageId: number): void {
    const cacheKey = this.makeKey(table, pageId);
    const frame = this.pool.get(cacheKey);
    if (frame) {
      frame.isDirty = true;
    }
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

  /**
   * Evicts the least recently used page from RAM
   */
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
}
