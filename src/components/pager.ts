import fs, { FileHandle } from 'node:fs/promises';
import { PAGE_SIZE } from '../constants';

export class Pager {
  private filePath: string;
  private fileHandle: FileHandle | null = null;
  private totalPages: number = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Opens the file handle. If the file doesn't exist, 'r+' creates an error, 
   * so we use 'a+' or open with 'w+' if it's a new file. 'r+' ensures we can read and write.
   */
  async open(): Promise<void> {
    // Open for reading and writing. The file is created if it does not exist.
    this.fileHandle = await fs.open(this.filePath, 'a+');

    // Re-open in r+ mode so we can write at arbitrary offsets (a+ forces writes to EOF)
    await this.fileHandle.close();
    this.fileHandle = await fs.open(this.filePath, 'r+');

    const stat = await this.fileHandle.stat();
    this.totalPages = Math.floor(stat.size / PAGE_SIZE);
  }

  /**
   * Reads a 4KB page from disk into a fresh Buffer
   */
  async readPage(pageId: number): Promise<Buffer> {
    if (!this.fileHandle) throw new Error("Pager is not open");

    const buffer = Buffer.alloc(PAGE_SIZE);
    const offset = pageId * PAGE_SIZE;

    // Read exactly PAGE_SIZE bytes starting at 'offset' in the file
    // and write them into 'buffer' starting at position 0
    const { bytesRead } = await this.fileHandle.read(buffer, 0, PAGE_SIZE, offset);

    // If we read less than 4KB, it's either an uninitialized page or corrupted
    if (bytesRead < PAGE_SIZE && bytesRead > 0) {
      throw new Error(`Corrupted read: Got ${bytesRead} bytes instead of ${PAGE_SIZE} for page ${pageId}`);
    }

    return buffer;
  }

  /**
   * Writes a 4KB buffer to a specific pageId on disk
   */
  async writePage(pageId: number, buffer: Buffer): Promise<void> {
    if (!this.fileHandle) throw new Error("Pager is not open");
    if (buffer.length !== PAGE_SIZE) {
      throw new Error(`Buffer size must be exactly ${PAGE_SIZE} bytes`);
    }

    const offset = pageId * PAGE_SIZE;

    // Write the buffer to the calculated byte offset
    await this.fileHandle.write(buffer, 0, PAGE_SIZE, offset);

    // Track if we just grew the file size
    if (pageId >= this.totalPages) {
      this.totalPages = pageId + 1;
    }
  }

  /**
   * Allocates a brand new empty page at the end of the file
   */
  async allocatePage(): Promise<number> {
    const newPageId = this.totalPages;
    const emptyBuffer = Buffer.alloc(PAGE_SIZE);

    await this.writePage(newPageId, emptyBuffer);
    return newPageId;
  }

  /**
   * Safely flushes data to disk and closes the file handle
   */
  async close(): Promise<void> {
    if (this.fileHandle) {
      await this.fileHandle.sync(); // Force OS cache to flush to physical disk
      await this.fileHandle.close();
      this.fileHandle = null;
    }
  }

  getTotalPages(): number {
    return this.totalPages;
  }
}
