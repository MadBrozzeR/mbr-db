import { PAGE_SIZE, HEADER_SIZE, SLOT_SIZE } from '../constants';
import { CacheFrame } from './buffer-pool';
import { ControlledError } from './errors';

export class PageManager {
  private pageBuffer: Buffer | null;
  private cacheFrame: CacheFrame | null;

  constructor(pageBuffer?: Buffer | null, cacheFrame?: CacheFrame | null) {
    this.pageBuffer = pageBuffer || null;
    this.cacheFrame = cacheFrame || null;
  }

  markDirty() {
    this.cacheFrame && (this.cacheFrame.isDirty = true);
  }

  setTarget(buffer: Buffer, cacheFrame?: CacheFrame) {
    this.pageBuffer = buffer;
    this.cacheFrame = cacheFrame || null;
    return this;
  }

  private getBuffer() {
    if (!this.pageBuffer) {
      throw new ControlledError('PAGE_MANAGER_EMPTY');
    }

    return this.pageBuffer;
  }

  /**
   * Formats a raw blank buffer with baseline database metadata headers.
   */
  init(pageType: number, nextPageId: number = 0): void {
    this.getBuffer().fill(0); // Clean slate
    this.getBuffer().writeUInt16BE(pageType, 0);       // page_type
    this.getBuffer().writeUInt16BE(0, 2);              // slot_count
    this.getBuffer().writeUInt16BE(PAGE_SIZE, 4);      // free_space_pointer (starts at 4096)
    this.getBuffer().writeUInt16BE(0, 6);              // deleted_bytes
    this.setNextPageId(nextPageId);                   // next_page_id
    this.markDirty();
  }

  // --- Header Getters & Setters ---
  getPageType(): number { return this.getBuffer().readUInt16BE(0); }
  getSlotCount(): number { return this.getBuffer().readUInt16BE(2); }
  private setSlotCount(value: number) { this.getBuffer().writeUInt16BE(value, 2); this.markDirty(); }
  getFreeSpacePointer(): number { return this.getBuffer().readUInt16BE(4); }
  private setFreeSpacePointer(value: number) { this.getBuffer().writeUInt16BE(value, 4); this.markDirty(); }
  getDeletedBytes(): number { return this.getBuffer().readUInt16BE(6); }
  private setDeletedBytes(value: number) { this.getBuffer().writeUInt16BE(value, 6); this.markDirty(); }
  getNextPageId(): number { return this.getBuffer().readUInt32BE(8); }

  /**
   * Calculates how much space is left for new rows before triggering a split.
   */
  getAvailableFreeSpace(): number {
    const slotCount = this.getSlotCount();
    const currentSlotEnd = HEADER_SIZE + (slotCount * SLOT_SIZE);
    const freeSpacePointer = this.getFreeSpacePointer();

    // Contiguous space between the slot array end and the last data payload
    return freeSpacePointer - currentSlotEnd;
  }

  checkSpaceIsAvailable(size: number) {
    const available = this.getAvailableFreeSpace();

    if (size <= available) {
      return true;
    }

    return size <= (available + this.getDeletedBytes());
  }

  setNextPageId(id: number) {
    this.getBuffer().writeUInt32BE(id, 8);
    this.markDirty();
  }

  /**
   * Inserts a packed row into the page. Returns the assigned slotIndex.
   */
  insertRow(rowBuffer: Buffer): number {
    const requiredSpace = SLOT_SIZE + rowBuffer.length;
    let available = this.getAvailableFreeSpace();

    // If we have fragmentation, try defragmenting first
    if (available < requiredSpace && (available + this.getDeletedBytes()) >= requiredSpace) {
      this.defragment();
      available = this.getAvailableFreeSpace();
    }

    if (available < requiredSpace) {
      throw new ControlledError('PAGE_OUT_OF_SPACE');
    }

    const slotCount = this.getSlotCount();
    const newFreeSpacePointer = this.getFreeSpacePointer() - rowBuffer.length;

    // 1. Copy the row data to the bottom of the page
    rowBuffer.copy(this.getBuffer(), newFreeSpacePointer);

    // 2. Append the 4-byte slot pointer at the end of the slot array
    const slotOffset = HEADER_SIZE + (slotCount * SLOT_SIZE);
    this.getBuffer().writeUInt16BE(newFreeSpacePointer, slotOffset); // Data Offset
    this.getBuffer().writeUInt16BE(rowBuffer.length, slotOffset + 2); // Data Length

    // 3. Update headers
    this.setSlotCount(slotCount + 1);
    this.setFreeSpacePointer(newFreeSpacePointer);
    this.markDirty();
    return slotCount; // Returns the index pointer to this row
  }

  /**
   * Extracts a specific single row slice using its slot index.
   */
  getRow(slotIndex: number): Buffer | null {
    if (slotIndex < 0 || slotIndex >= this.getSlotCount()) return null;

    const slotOffset = HEADER_SIZE + (slotIndex * SLOT_SIZE);
    const offset = this.getBuffer().readUInt16BE(slotOffset);
    const length = this.getBuffer().readUInt16BE(slotOffset + 2);

    // An offset of 0 flags a deleted row slot
    if (offset === 0) return null;

    // Return a zero-copy direct view into the page frame memory
    return this.getBuffer().subarray(offset, offset + length);
  }

  /**
   * Deletes a row by marking its slot offset to 0.
   * The space is reclaimed automatically later via defragmentation.
   */
  deleteRow(slotIndex: number): boolean {
    if (slotIndex < 0 || slotIndex >= this.getSlotCount()) return false;

    const slotOffset = HEADER_SIZE + (slotIndex * SLOT_SIZE);
    const offset = this.getBuffer().readUInt16BE(slotOffset);
    const length = this.getBuffer().readUInt16BE(slotOffset + 2);

    if (offset === 0) return false; // Already deleted

    // Soft delete: clear out slot data coordinates, preserve index slot position
    this.getBuffer().writeUInt32BE(0, slotOffset);

    // Add this to our fragmentation counter
    this.setDeletedBytes(this.getDeletedBytes() + length);
    this.markDirty();
    return true;
  }

  /**
   * Compacts the page to eliminate holes left by deleted rows.
   */
  defragment(): void {
    const slotCount = this.getSlotCount();
    // Temporary buffer to stage clean, consecutive payloads
    const tempBuffer = Buffer.alloc(PAGE_SIZE);
    let tempPointer = PAGE_SIZE;

    // Loop through slots to pack valid data rows into temp storage
    for (let index = 0; index < slotCount; ++index) {
      const slotOffset = HEADER_SIZE + (index * SLOT_SIZE);
      const offset = this.getBuffer().readUInt16BE(slotOffset);
      const length = this.getBuffer().readUInt16BE(slotOffset + 2);

      if (offset !== 0) {
        tempPointer -= length;
        this.getBuffer().copy(tempBuffer, tempPointer, offset, offset + length);

        // Rewrite active slot with its updated layout coordinates
        this.getBuffer().writeUInt16BE(tempPointer, slotOffset);
      }
    }

    // Flush packed rows back onto our page frame
    tempBuffer.copy(this.getBuffer(), tempPointer, tempPointer, PAGE_SIZE);
    this.setFreeSpacePointer(tempPointer);
    this.setDeletedBytes(0); // All fragmented space reclaimed!
    this.markDirty();
  }

  clone() {
    return new PageManager(this.pageBuffer, this.cacheFrame);
  }
}
