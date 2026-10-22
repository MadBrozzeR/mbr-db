import { PAGE_SIZE, HEADER_SIZE, SLOT_SIZE, PAGE_HEADER_MASK, PAGE_TYPE } from '../constants';
import { deserializeRow, serializeRow } from '../utils/buffer-utils';
import { BinarySearch } from '../utils/math-utils';
import { CacheFrame } from './buffer-pool';
import { ControlledError } from './errors';

type BinarySearchParams = { key: Buffer; manager: PageManager };
const DEFAULT_BUFFER = Buffer.alloc(0);

export class PageManager {
  private pageBuffer: Buffer;
  private cacheFrame: CacheFrame | null;
  static search = new BinarySearch<BinarySearchParams>(function (index, params) {
    const currentKey = params.manager.getKeyFromSlot(index);
    if (currentKey === null) {
      return;
    }

    return params.key.compare(currentKey);
  });

  constructor(pageBuffer?: Buffer, cacheFrame?: CacheFrame | null) {
    this.pageBuffer = pageBuffer || DEFAULT_BUFFER;
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
    return this.pageBuffer;
  }

  /**
   * Sets the Leftmost Child Pointer for internal routing nodes.
   * Reuses the next_page_id header slot (Bytes 8-11).
   */
  setLeftmostChildId(pageId: number): void {
    this.setNextPageId(pageId);
  }

  /**
   * Retrieves the Leftmost Child Pointer for internal routing nodes.
   */
  getLeftmostChildId(): number {
    return this.getNextPageId();
  }

  /**
   * Formats a raw blank buffer with baseline database metadata headers.
   */
  init(pageType: (typeof PAGE_TYPE)[keyof typeof PAGE_TYPE]): void {
    const buffer = this.getBuffer();
    buffer.fill(0); // Clean slate
    buffer.writeUInt8(pageType, 0);       // page_type
    buffer.writeUInt8(0, 1);       // reserved
    buffer.writeUInt16BE(0, 2);              // slot_count
    buffer.writeUInt16BE(PAGE_SIZE, 4);      // free_space_pointer (starts at 4096)
    buffer.writeUInt16BE(0, 6);              // deleted_bytes
    // this.setNextPageId(nextPageId);                   // next_page_id
    this.markDirty(); // no need in making it dirty, because setNextPageId already done it.
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

  private requestAvailableSpace(bufferSize: number) {
    const requiredSpace = SLOT_SIZE + bufferSize;
    const available = this.getAvailableFreeSpace();

    if (available < requiredSpace) {
      if ((available + this.getDeletedBytes()) < requiredSpace) {
        throw new ControlledError('PAGE_OUT_OF_SPACE');
      }
      // If we have fragmentation, try defragmenting first
      this.defragment();
    }
  }

  private addRecord(slotIndex: number, rowBuffer: Buffer, slotCount = this.getSlotCount()) {
    const pageBuffer = this.getBuffer();
    const newFreeSpacePointer = this.getFreeSpacePointer() - rowBuffer.length;

    // 2. Copy the record data payload to the bottom of the page frame
    rowBuffer.copy(pageBuffer, newFreeSpacePointer);

    // 3. Shift the 4-byte slot pointers to open up a vacant position
    if (slotIndex < slotCount) {
      const sourceOffset = HEADER_SIZE + (slotIndex * SLOT_SIZE);
      const destinationOffset = sourceOffset + SLOT_SIZE;
      const bytesToShift = (slotCount - slotIndex) * SLOT_SIZE;

      // Safe overlapping block memory shift inside the native buffer
      pageBuffer.copy(pageBuffer, destinationOffset, sourceOffset, sourceOffset + bytesToShift);
    }

    // 4. Write coordinates into the newly created slot gap
    const targetSlotOffset = HEADER_SIZE + (slotIndex * SLOT_SIZE);
    pageBuffer.writeUInt16BE(newFreeSpacePointer, targetSlotOffset);
    pageBuffer.writeUInt16BE(rowBuffer.length, targetSlotOffset + 2);

    // 5. Commit structural header changes
    this.setSlotCount(slotCount + 1);
    this.setFreeSpacePointer(newFreeSpacePointer);
    // this.markDirty(); // Done above

    return slotIndex;
  }

  /**
   * Inserts a packed row into the page. Returns the assigned slotIndex.
   */
  insertRow(rowBuffer: Buffer): number {
    this.requestAvailableSpace(rowBuffer.length);
    const slotCount = this.getSlotCount();
    return this.addRecord(slotCount, rowBuffer, slotCount);
  }

  /**
   * Extracts a specific single row slice using its slot index.
   */
  getRow(slotIndex: number): Buffer | null {
    const buffer = this.getBuffer();
    if (slotIndex < 0 || slotIndex >= this.getSlotCount()) return null;

    const slotOffset = HEADER_SIZE + (slotIndex * SLOT_SIZE);
    const offset = buffer.readUInt16BE(slotOffset);
    const length = buffer.readUInt16BE(slotOffset + 2);

    // An offset of 0 flags a deleted row slot
    if (offset === 0) return null;

    // Return a zero-copy direct view into the page frame memory
    return buffer.subarray(offset, offset + length);
  }

  updateRowFixed(slotIndex: number, rowBuffer: Buffer) {
    const buffer = this.getBuffer();
    const slotOffset = HEADER_SIZE + (slotIndex * SLOT_SIZE);
    const offset = buffer.readUInt16BE(slotOffset);
    const currentData = this.getRow(slotIndex);

    if (!currentData) {
      throw new ControlledError('RECORD_NOT_FOUND');
    }
    if (rowBuffer.length !== currentData.length) {
      throw new ControlledError('SIZE_DOES_NOT_MATCH', { source: currentData.length, target: rowBuffer.length });
    }
    if (currentData.compare(rowBuffer) === 0) {
      return;
    }
    rowBuffer.copy(buffer, offset);
  }

  /**
   * Deletes a row by marking its slot offset to 0.
   * The space is reclaimed automatically later via defragmentation.
   */
  deleteRow(slotIndex: number): boolean {
    const buffer = this.getBuffer();
    if (slotIndex < 0 || slotIndex >= this.getSlotCount()) return false;

    const slotOffset = HEADER_SIZE + (slotIndex * SLOT_SIZE);
    const offset = buffer.readUInt16BE(slotOffset);
    const length = buffer.readUInt16BE(slotOffset + 2);

    if (offset === 0) return false; // Already deleted

    // Soft delete: clear out slot data coordinates, preserve index slot position
    buffer.writeUInt32BE(0, slotOffset);

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
    this.requestAvailableSpace(rowBuffer.length);

    const newKey = deserializeRow(rowBuffer, 1)[0];
    if (!newKey) {
      throw new Error("Cannot insert into sorted page: Row is missing an index key in Field 0.");
    }

    const slotCount = this.getSlotCount();
    const searcParams = { key: newKey, manager: this };

    let targetSlotIndex = PageManager.search.run(slotCount, searcParams);

    if (targetSlotIndex !== -1) {
      throw new ControlledError('DUPLICATE_RECORD_ID', { id: `<${newKey.toString('hex')}>` });
    }

    targetSlotIndex = PageManager.search.high;

    return this.addRecord(targetSlotIndex, rowBuffer, slotCount);
  }

  /**
   * Evaluates a search key against the internal node routing table
   * to determine the exact child Page ID that must be traversed next.
   */
  routeToChildPage(searchKey: Buffer): number {
    const slotCount = this.getSlotCount();
    if (slotCount === 0) {
      return this.getLeftmostChildId();
    }

    // Run interval binary search to find boundaries
    const searchParams = { key: searchKey, manager: this };
    const searchResult = PageManager.search.run(slotCount, searchParams);

    // Direct hit found on a routing partition boundary key
    if (searchResult > -1) {
      const rowBuffer = this.getRow(searchResult)!;
      const fields = deserializeRow(rowBuffer);
      if (!fields[1]) {
        throw new ControlledError('FIELD_NOT_FOUND');
      }

      return fields[1].readUInt32BE(0);
    }

    // Interval Invariant Match:
    // If PageManager.search.low remains -1, our search key is strictly smaller
    // than the smallest routing key on this page. Route to Leftmost Child.
    if (PageManager.search.low === -1) {
      return this.getLeftmostChildId();
    }

    // Otherwise, low points to the closest routing key that is smaller than or equal
    // to our search key. Follow its corresponding right-hand child page ID pointer.
    const rowBuffer = this.getRow(PageManager.search.low);
    if (!rowBuffer) {
      throw new ControlledError('FIELD_NOT_FOUND');
    }
    const fields = deserializeRow(rowBuffer);
    if (!fields[1]) {
      throw new ControlledError('FIELD_NOT_FOUND');
    }
    return fields[1].readUInt32BE(0);
  }

  /**
   * Inserts a routing key and its associated right-hand child page ID
   * into an internal routing node, keeping entries strictly sorted.
   */
  insertRoutingKey(key: Buffer, childPageId: number): number {
    // 1. Serialize the 4-byte UInt32 child pointer to a raw buffer
    const pointerBuffer = Buffer.alloc(4);
    pointerBuffer.writeUInt32BE(childPageId, 0);

    // 2. Pack key and pointer into a standard database row tuple
    const routingRow = serializeRow([key, pointerBuffer]);

    // 3. Utilize your interval binary search to determine the insertion slot
    const slotCount = this.getSlotCount();
    const searchParams = { key, manager: this };
    const searchResult = PageManager.search.run(slotCount, searchParams);

    // B+ Tree Internal Nodes can update pointer mappings if a duplicate routing key is inserted
    if (searchResult > -1) {
      // Direct hit: Overwrite the existing routing slot with the updated child path
      this.updateRowFixed(searchResult, routingRow);
      return searchResult;
    } else {
      // 4. Perform regular sorted insertion using the calculated high boundary index
      const targetSlotIndex = PageManager.search.high;
      this.requestAvailableSpace(routingRow.length);
      return this.addRecord(targetSlotIndex, routingRow);
    }
  }

  /**
   * Performs an O(log N) point-lookup search for a unique key on this page.
   * Returns the raw record Buffer slice if found, or null if the key does not exist.
   */
  findKey(key: Buffer): Buffer | null {
    const slotCount = this.getSlotCount();
    if (slotCount === 0) {
      return null;
    }

    const searchParams = { key, manager: this };

    // Execute your zero-allocation interval binary search
    const searchResult = PageManager.search.run(slotCount, searchParams);

    // Direct hit: The key exists exactly at the index returned by searchResult
    if (searchResult > -1) {
      return this.getRow(searchResult);
    }

    // Interval Invariant Match: Key was not found on this page
    return null;
  }
}
