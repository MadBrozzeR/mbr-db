import { PAGE_SIZE, HEADER_SIZE, SLOT_SIZE, PAGE_HEADER_MASK, PAGE_TYPE } from '../constants';
import { deserializeRow } from '../utils/buffer-utils';
import { BinarySearch } from '../utils/math-utils';
import { CacheFrame } from './buffer-pool';
import { ControlledError } from './errors';

type BinarySearcParams = { key: Buffer; manager: PageManager };

export class PageManager {
  private pageBuffer: Buffer | null;
  private cacheFrame: CacheFrame | null;
  static search = new BinarySearch<BinarySearcParams>(function (index, params) {
    const currentKey = params.manager.getKeyFromSlot(index);
    if (currentKey === null) {
      return;
    }

    return params.key.compare(currentKey);
  });

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

  getBuffer() {
    if (!this.pageBuffer) {
      throw new ControlledError('PAGE_MANAGER_EMPTY');
    }

    return this.pageBuffer;
  }

  /**
   * Formats a raw blank buffer with baseline database metadata headers.
   */
  init(pageType: (typeof PAGE_TYPE)[keyof typeof PAGE_TYPE], nextPageId: number = 0): void {
    const buffer = this.getBuffer();
    buffer.fill(0); // Clean slate
    buffer.writeUInt8(pageType, 0);       // page_type
    buffer.writeUInt8(0, 1);       // reserved
    buffer.writeUInt16BE(0, 2);              // slot_count
    buffer.writeUInt16BE(PAGE_SIZE, 4);      // free_space_pointer (starts at 4096)
    buffer.writeUInt16BE(0, 6);              // deleted_bytes
    this.setNextPageId(nextPageId);                   // next_page_id
    // this.markDirty(); // no need in making it dirty, because setNextPageId already done it.
  }

  private setBit(byteIndex: number, mask: number, isSet = true) {
    const buffer = this.getBuffer();
    const current = buffer.readUInt8(byteIndex);
    const newValue = isSet ? (current | mask) : (current & ~mask);
    if (current !== newValue) {
      buffer.writeUInt8(newValue);
      this.markDirty();
    }
  }

  // --- Header Getters & Setters ---
  getPageType(): number { return this.getBuffer().readUInt8(0) & PAGE_HEADER_MASK.TYPE_MASK; }
  getSlotCount(): number { return this.getBuffer().readUInt16BE(2); }
  getFreeSpacePointer(): number { return this.getBuffer().readUInt16BE(4); }
  getDeletedBytes(): number { return this.getBuffer().readUInt16BE(6); }
  getNextPageId(): number { return this.getBuffer().readUInt32BE(8); }
  isRootPage() { return this.getBuffer().readUint8(0) & PAGE_HEADER_MASK.IS_ROOT }
  private setSlotCount(value: number) { this.getBuffer().writeUInt16BE(value, 2); this.markDirty(); }
  private setFreeSpacePointer(value: number) { this.getBuffer().writeUInt16BE(value, 4); this.markDirty(); }
  private setDeletedBytes(value: number) { this.getBuffer().writeUInt16BE(value, 6); this.markDirty(); }
  setRootPage(value: boolean) { this.setBit(0, PAGE_HEADER_MASK.IS_ROOT, value); }

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
    const pageBuffer = this.getBuffer();

    // Loop through slots to pack valid data rows into temp storage
    for (let index = 0; index < slotCount; ++index) {
      const slotOffset = HEADER_SIZE + (index * SLOT_SIZE);
      const offset = pageBuffer.readUInt16BE(slotOffset);
      const length = pageBuffer.readUInt16BE(slotOffset + 2);

      if (offset !== 0) {
        tempPointer -= length;
        pageBuffer.copy(tempBuffer, tempPointer, offset, offset + length);

        // Rewrite active slot with its updated layout coordinates
        pageBuffer.writeUInt16BE(tempPointer, slotOffset);
      }
    }

    // Flush packed rows back onto our page frame
    tempBuffer.copy(pageBuffer, tempPointer, tempPointer, PAGE_SIZE);
    this.setFreeSpacePointer(tempPointer);
    this.setDeletedBytes(0); // All fragmented space reclaimed!
    this.markDirty();
  }

  clone() {
    return new PageManager(this.pageBuffer, this.cacheFrame);
  }

  /**
   * Helper to extract the comparison key (Field 0) from a raw row stored in the page buffer.
   */
  private getKeyFromSlot(slotIndex: number): Buffer | null {
    const rowBuffer = this.getRow(slotIndex);
    if (rowBuffer === null) {
      return null;
    }

    const fields = deserializeRow(rowBuffer, 1);
    // Field 0 is naturally our indexing key payload
    return fields[0] || null;
  }

  /**
   * Inserts a record and maintains strict sorting inside the slot array.
   */
  insertSortedRow(rowBuffer: Buffer): number {
    const pageBuffer = this.getBuffer();
    const requiredSpace = SLOT_SIZE + rowBuffer.length;
    let available = this.getAvailableFreeSpace();

    if (available < requiredSpace && (available + this.getDeletedBytes()) >= requiredSpace) {
      this.defragment();
      available = this.getAvailableFreeSpace();
    }

    if (available < requiredSpace) {
      throw new ControlledError('PAGE_OUT_OF_SPACE');
    }

    const newKey = deserializeRow(rowBuffer, 1)[0];
    if (!newKey) {
      throw new Error("Cannot insert into sorted page: Row is missing an index key in Field 0.");
    }

    const slotCount = this.getSlotCount();
    const searcParams = { key: newKey, manager: this };

    let targetSlotIndex = PageManager.search.run(slotCount, searcParams);

    if (targetSlotIndex !== -1) {
      targetSlotIndex = PageManager.search.high;
    } else {
      throw new ControlledError('DUPLICATE_RECORD_ID', { id: `<${newKey.toString('hex')}>` });
    }

    const newFreeSpacePointer = this.getFreeSpacePointer() - rowBuffer.length;

    // 2. Copy the record data payload to the bottom of the page frame
    rowBuffer.copy(pageBuffer, newFreeSpacePointer);

    // 3. Shift the 4-byte slot pointers to open up a vacant position
    if (targetSlotIndex < slotCount) {
      const sourceOffset = HEADER_SIZE + (targetSlotIndex * SLOT_SIZE);
      const destinationOffset = sourceOffset + SLOT_SIZE;
      const bytesToShift = (slotCount - targetSlotIndex) * SLOT_SIZE;

      // Safe overlapping block memory shift inside the native buffer
      pageBuffer.copy(pageBuffer, destinationOffset, sourceOffset, sourceOffset + bytesToShift);
    }

    // 4. Write coordinates into the newly created slot gap
    const targetSlotOffset = HEADER_SIZE + (targetSlotIndex * SLOT_SIZE);
    pageBuffer.writeUInt16BE(newFreeSpacePointer, targetSlotOffset);
    pageBuffer.writeUInt16BE(rowBuffer.length, targetSlotOffset + 2);

    // 5. Commit structural header changes
    this.setSlotCount(slotCount + 1);
    this.setFreeSpacePointer(newFreeSpacePointer);
    // this.markDirty(); // Done above

    return targetSlotIndex;
  }
}
