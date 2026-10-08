import { Pager } from './pager';

export interface CacheFrame {
  pageId: number;
  buffer: Buffer;
  isDirty: boolean; // True if memory changed but hasn't been written to disk yet
}

export class BufferPool {
  private pager: Pager;
  private maxPages: number;
  private pool: Map<number, CacheFrame> = new Map();

  constructor(pager: Pager, maxPages: number = 10) {
    this.pager = pager;
    this.maxPages = maxPages;
  }

  /**
   * Retrieves a page buffer. Uses cache if available, otherwise reads from disk.
   */
  async getPage(pageId: number): Promise<Buffer> {
    // Cache Hit
    if (this.pool.has(pageId)) {
      const frame = this.pool.get(pageId)!;
      // Refresh LRU order by deleting and re-inserting
      this.pool.delete(pageId);
      this.pool.set(pageId, frame);
      return frame.buffer;
    }

    // Cache Miss -> Evict oldest page if pool is full
    if (this.pool.size >= this.maxPages) {
      await this.evictOne();
    }

    // Read from physical disk via Pager
    const buffer = await this.pager.readPage(pageId);

    this.pool.set(pageId, {
      pageId,
      buffer,
      isDirty: false
    });

    return buffer;
  }

  /**
   * Marks a page buffer as modified (dirty) so we know it needs flushing later
   */
  markDirty(pageId: number): void {
    const frame = this.pool.get(pageId);
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
        await this.pager.writePage(frame.pageId, frame.buffer);
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
      await this.pager.writePage(frame.pageId, frame.buffer);
    }

    this.pool.delete(oldestKey);
  }
}
