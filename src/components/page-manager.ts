import { CacheFrame } from './buffer-pool';
import { SIZE, OFFSET, PageType, PAGE_HEADER_MASK, PAGE_TYPE } from '../constants';
import { deserializeRow, getChildId, serializeRow } from '../utils/buffer-utils';
import { BinarySearch } from '../utils/math-utils';
import { AppError } from '../utils/errors';
import { assertPageType } from '../utils/type-utils';

type BinarySearchParams = { key: Buffer; manager: PageManager };
const DEFAULT_BUFFER = Buffer.alloc(0);

export class Slot {
  index = 0;
  private pageManager: PageManager;

  constructor(pageManager: PageManager) {
    this.pageManager = pageManager;
  }

  setIndex(value: number) {
    this.index = value;
    return this;
  }

  getOffset() {
    return SIZE.HEADER + this.index * SIZE.SLOT;
  }

  hasData() {
    return this.pageManager.getBuffer().readUInt16BE(this.getOffset()) !== 0;
  }

  getRow() {
    return this.pageManager.getRow(this.index);
  }
}

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
  private slot = new Slot(this);

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
  setLeftmostChildId(pageId: Buffer | number): void {
    if (typeof pageId === 'number') {
      this.getBuffer().writeUInt32BE(pageId, OFFSET.NEXT_PAGE_ID);
    } else {
      if (pageId.length !== 4) {
        throw new AppError('WRONG_FIELD_SIZE', { size: pageId.length, required: 4 });
      }
      pageId.copy(this.getBuffer(), OFFSET.NEXT_PAGE_ID, 0, OFFSET.NEXT_PAGE_ID);
    }
    this.markDirty();
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
  init(pageType: PageType): void {
    const buffer = this.getBuffer();
    buffer.fill(0); // Clean slate
    buffer.writeUInt8(pageType, 0);                              // page_type
    buffer.writeUInt8(0, 1);                                     // reserved
    buffer.writeUInt16BE(0, OFFSET.SLOT_COUNT);                  // slot_count
    buffer.writeUInt16BE(SIZE.PAGE, OFFSET.FREE_SPACE_POINTER);  // free_space_pointer (starts at 4096)
    buffer.writeUInt16BE(0, OFFSET.DELETET_BYTES);               // deleted_bytes
    // this.setNextPageId(nextPageId);                           // next_page_id
    this.markDirty();
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
  getPageType(): PageType { return assertPageType(this.getBuffer().readUInt8(0) & PAGE_HEADER_MASK.TYPE_MASK); }
  getSlotCount(): number { return this.getBuffer().readUInt16BE(2); }
  getSlotOffset(index: number) { return SIZE.HEADER + index * SIZE.SLOT; }
  getFreeSpacePointer(): number { return this.getBuffer().readUInt16BE(4); }
  getDeletedBytes(): number { return this.getBuffer().readUInt16BE(6); }
  getNextPageId(): number { return this.getBuffer().readUInt32BE(8); }
  isRootPage() { return this.getBuffer().readUint8(0) & PAGE_HEADER_MASK.IS_ROOT }
  private setSlotCount(value: number) { this.getBuffer().writeUInt16BE(value, 2); this.markDirty(); }
  private setFreeSpacePointer(value: number) { this.getBuffer().writeUInt16BE(value, 4); this.markDirty(); }
  private setDeletedBytes(value: number) { this.getBuffer().writeUInt16BE(value, 6); this.markDirty(); }
  setRootPage(value: boolean) { this.setBit(0, PAGE_HEADER_MASK.IS_ROOT, value); }

  findMiddleSlotIndex() {
    const buffer = this.getBuffer();
    const slotCount = this.getSlotCount();
    const indexes: number[] = [];
    let currentOffset = SIZE.HEADER;
    for (let index = 0 ; index < slotCount ; ++index) {
      if (buffer.readUInt16BE(currentOffset) !== 0) {
        indexes.push(index);
      }
      currentOffset += SIZE.SLOT;
    }
    return indexes[indexes.length >> 1] || -1;
  }

  *iterateSlots(start = 0) {
    const slotCount = this.getSlotCount();

    for (let index = start ; index < slotCount ; ++index) {
      yield this.slot.setIndex(index);
    }
  }

  /**
   * Calculates how much space is left for new rows before triggering a split.
   */
  getAvailableFreeSpace(): number {
    const slotCount = this.getSlotCount();
    const currentSlotEnd = this.getSlotOffset(slotCount);
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
    const requiredSpace = SIZE.SLOT + bufferSize;
    const available = this.getAvailableFreeSpace();

    if (available < requiredSpace) {
      if ((available + this.getDeletedBytes()) < requiredSpace) {
        throw new AppError('PAGE_OUT_OF_SPACE');
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
      const sourceOffset = this.getSlotOffset(slotIndex);
      const destinationOffset = sourceOffset + SIZE.SLOT;
      const bytesToShift = (slotCount - slotIndex) * SIZE.SLOT;

      // Safe overlapping block memory shift inside the native buffer
      pageBuffer.copy(pageBuffer, destinationOffset, sourceOffset, sourceOffset + bytesToShift);
    }

    // 4. Write coordinates into the newly created slot gap
    const targetSlotOffset = this.getSlotOffset(slotIndex);
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

    const slotOffset = this.getSlotOffset(slotIndex);
    const offset = buffer.readUInt16BE(slotOffset);
    const length = buffer.readUInt16BE(slotOffset + 2);

    // An offset of 0 flags a deleted row slot
    if (offset === 0) return null;

    // Return a zero-copy direct view into the page frame memory
    return buffer.subarray(offset, offset + length);
  }

  updateRowFixed(slotIndex: number, rowBuffer: Buffer) {
    const buffer = this.getBuffer();
    const slotOffset = this.getSlotOffset(slotIndex);
    const offset = buffer.readUInt16BE(slotOffset);
    const currentData = this.getRow(slotIndex);

    if (!currentData) {
      throw new AppError('RECORD_NOT_FOUND');
    }
    if (rowBuffer.length !== currentData.length) {
      throw new AppError('SIZE_DOES_NOT_MATCH', { source: currentData.length, target: rowBuffer.length });
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

    const slotOffset = this.getSlotOffset(slotIndex);
    const offset = buffer.readUInt16BE(slotOffset);
    const length = buffer.readUInt16BE(slotOffset + 2);

    if (offset === 0) return false; // Already deleted

    // Soft delete: clear out slot data coordinates, preserve index slot position
    buffer.writeUInt32BE(0, slotOffset);

    // Add this to our fragmentation counter
    this.setDeletedBytes(this.getDeletedBytes() + length + SIZE.SLOT);
    this.markDirty();
    return true;
  }

  /**
   * Compacts the page to eliminate holes left by deleted rows.
   */
  defragment(): void {
    const slotCount = this.getSlotCount();
    const tempBuffer = Buffer.alloc(SIZE.PAGE);
    let tempPointer = SIZE.PAGE;
    const pageBuffer = this.getBuffer();
    let newSlotCount = 0;
    let slotOffset = SIZE.HEADER;
    let newSlotOffset = SIZE.HEADER;

    for (let index = 0; index < slotCount; ++index) {
      const offset = pageBuffer.readUInt16BE(slotOffset);
      const length = pageBuffer.readUInt16BE(slotOffset + 2);

      if (offset !== 0) {
        tempPointer -= length;
        pageBuffer.copy(tempBuffer, tempPointer, offset, offset + length);

        pageBuffer.writeUInt16BE(tempPointer, newSlotOffset);
        pageBuffer.writeUInt16BE(length, newSlotOffset + 2);
        newSlotOffset += SIZE.SLOT;
        ++newSlotCount;
      }
      slotOffset += SIZE.SLOT;
    }

    pageBuffer.fill(0, newSlotOffset, tempPointer);
    tempBuffer.copy(pageBuffer, tempPointer, tempPointer, SIZE.PAGE);
    tempBuffer.copy(pageBuffer, SIZE.HEADER, SIZE.HEADER, newSlotOffset);
    this.setFreeSpacePointer(tempPointer);
    this.setDeletedBytes(0);
    this.setSlotCount(newSlotCount);
    // this.markDirty();
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

  insertRowOrSortingKey(rowBuffer: Buffer, key: Buffer) {
    const type = this.getPageType();
    switch (type) {
      case PAGE_TYPE.TREE_LEAF:
        return this.insertSortedRow(rowBuffer, key);
      case PAGE_TYPE.TREE_INTERNAL:
        return this.insertRoutingKey(key, rowBuffer);
      default:
        throw new AppError('PAGE_TYPE_UNHANDLED', { type });
    }
  }

  /**
   * Inserts a record and maintains strict sorting inside the slot array.
   */
  insertSortedRow(rowBuffer: Buffer, key?: Buffer): number {
    this.requestAvailableSpace(rowBuffer.length);

    const newKey = key || deserializeRow(rowBuffer, 1)[0];
    if (!newKey) {
      throw new Error("Cannot insert into sorted page: Row is missing an index key in Field 0.");
    }

    const slotCount = this.getSlotCount();
    const searcParams = { key: newKey, manager: this };

    let targetSlotIndex = PageManager.search.run(slotCount, searcParams);

    if (targetSlotIndex !== -1) {
      throw new AppError('DUPLICATE_RECORD_ID', { id: `<${newKey.toString('hex')}>` });
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
        throw new AppError('FIELD_NOT_FOUND');
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
      throw new AppError('FIELD_NOT_FOUND');
    }
    const fields = deserializeRow(rowBuffer);
    if (!fields[1]) {
      throw new AppError('FIELD_NOT_FOUND');
    }
    return fields[1].readUInt32BE(0);
  }

  /**
   * Inserts a routing key and its associated right-hand child page ID
   * into an internal routing node, keeping entries strictly sorted.
   */
  insertRoutingKey(key: Buffer, childPageId: number | Buffer): number {
    // 1. Serialize the 4-byte UInt32 child pointer to a raw buffer
    const pointerBuffer = getChildId(childPageId);

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

  clone() {
    return new PageManager(this.pageBuffer, this.cacheFrame);
  }
}
