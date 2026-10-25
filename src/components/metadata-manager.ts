import { METADATA_OFFSET } from '../constants';
import { PageManager } from './page-manager';

export class MetadataManager {
  private pageManager: PageManager;

  constructor(metadataPageManager: PageManager) {
    this.pageManager = metadataPageManager;
  }

  /**
   * Safe initialization routine to format a fresh Page 0 on disk.
   */
  init(initialRootId: number = 1): void {
    const buffer = this.pageManager.getBuffer();
    buffer.fill(0); // Clean slate security sweep

    // Write Page Type 0 to signal this is a dedicated Metadata tracking frame
    buffer.writeUInt8(0);

    // Seed initial system metadata pointers
    this.setRootPageId(initialRootId);
    this.setAutoIncrementSequence(BigInt(0)); // BigInt to support the full 8-byte space cleanly
  }

  /**
   * Retrieves the current entry point index tracking locator.
   */
  getRootPageId(): number {
    return this.pageManager.getBuffer().readUInt32BE(METADATA_OFFSET.ROOT_PAGE_ID);
  }

  /**
   * Updates the primary index root page reference point on disk.
   */
  setRootPageId(id: number): void {
    this.pageManager.getBuffer().writeUInt32BE(id, METADATA_OFFSET.AUTO_INCREMENT);
    this.pageManager.markDirty();
  }

  /**
   * Retrieves the active auto-increment record generator watermark.
   */
  getAutoIncrementSequence(): bigint {
    return this.pageManager.getBuffer().readBigUInt64BE(METADATA_OFFSET.AUTO_INCREMENT);
  }

  /**
   * Updates the active auto-increment sequence tracking registry value.
   */
  setAutoIncrementSequence(value: bigint): void {
    this.pageManager.getBuffer().writeBigUInt64BE(value, METADATA_OFFSET.AUTO_INCREMENT);
    this.pageManager.markDirty();
  }

  /**
   * Atomically increments the primary sequence identifier counter on the page frame
   * and returns the generated unique key.
   */
  nextAutoIncrementId(): bigint {
    const nextValue = this.getAutoIncrementSequence() + BigInt(1);
    this.setAutoIncrementSequence(nextValue);
    return nextValue;
  }
}

