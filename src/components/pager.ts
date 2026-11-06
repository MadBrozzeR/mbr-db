import path from 'node:path';
import fs, { FileHandle } from 'node:fs/promises';
import { SIZE } from '../constants';
import { AppError } from '../utils/errors';

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
  async open(): Promise<this> {
    if (this.fileHandle) {
      return this;
    }

    try {
      await fs.access(this.filePath, fs.constants.F_OK);
      this.fileHandle = await fs.open(this.filePath, 'r+');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        const dirname = path.dirname(this.filePath);
        await fs.mkdir(dirname, { recursive: true });
        // Open for reading and writing. The file is created if it does not exist.
        this.fileHandle = await fs.open(this.filePath, 'a+');
        // Re-open in r+ mode so we can write at arbitrary offsets (a+ forces writes to EOF)
        await this.fileHandle.close();
        this.fileHandle = await fs.open(this.filePath, 'r+');
      } else {
        throw error;
      }
    }

    const stat = await this.fileHandle.stat();
    this.totalPages = Math.floor(stat.size / SIZE.PAGE);

    return this;
  }

  /**
   * Reads a 4KB page from disk into a fresh Buffer
   */
  async readPage(pageId: number, reusedBuffer?: Buffer): Promise<Buffer> {
    if (!this.fileHandle) throw new AppError('PAGER_NOT_OPEN', { file: this.filePath });

    const buffer = reusedBuffer || Buffer.alloc(SIZE.PAGE);
    const offset = pageId * SIZE.PAGE;

    // Read exactly SIZE.PAGE bytes starting at 'offset' in the file
    // and write them into 'buffer' starting at position 0
    const { bytesRead } = await this.fileHandle.read(buffer, 0, SIZE.PAGE, offset);

    // If we read less than 4KB, it's either an uninitialized page or corrupted
    if (bytesRead < SIZE.PAGE) {
      throw new AppError('PAGE_CORRUPTED', { size: bytesRead, required: SIZE.PAGE, page: pageId });
    }

    return buffer;
  }

  /**
   * Writes a 4KB buffer to a specific pageId on disk
   */
  async writePage(pageId: number, buffer: Buffer): Promise<void> {
    if (!this.fileHandle) throw new AppError('PAGER_NOT_OPEN', { file: this.filePath });
    if (buffer.length !== SIZE.PAGE) {
      throw new AppError('WRONG_PAGE_SIZE', { size: SIZE.PAGE });
    }

    const offset = pageId * SIZE.PAGE;

    // Write the buffer to the calculated byte offset
    await this.fileHandle.write(buffer, 0, SIZE.PAGE, offset);

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
    const emptyBuffer = Buffer.alloc(SIZE.PAGE);

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
