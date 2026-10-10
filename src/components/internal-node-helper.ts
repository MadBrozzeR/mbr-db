import { PageManager } from "./page-manager";
import { deserializeRow, serializeRow } from "../utils/buffer-utils";
import { hasValue } from '../utils/type-utils';

export class InternalNodeHelper {
  private manager: PageManager;

  constructor(manager: PageManager) {
    if (manager.getPageType() !== 2) { // Assuming 2 represents PAGE_TYPE_INTERNAL
      throw new Error("Page is not configured as an internal routing node.");
    }
    this.manager = manager;
  }

  /**
   * Appends a routing boundary reference into the internal page.
   */
  addRoute(childPageId: number, boundaryKey: Buffer): number {
    const pageIdBuffer = Buffer.alloc(4);
    pageIdBuffer.writeUInt32BE(childPageId, 0);

    // Pack the pointer and key into a standard slotted row
    const routingRow = serializeRow([pageIdBuffer, boundaryKey]);
    return this.manager.insertRow(routingRow);
  }

  /**
   * Performs a linear scan or binary search to find the correct child page ID
   * for a given search key using byte-by-byte comparison.
   */
  findChildPageId(searchKey: Buffer): number {
    const slotCount = this.manager.getSlotCount();

    for (let index = 0; index < slotCount; ++index) {
      const rowBuffer = this.manager.getRow(index);
      if (rowBuffer === null) {
        continue;
      }

      const fields = deserializeRow(rowBuffer);
      const childPageIdBuffer = fields[0];
      const boundaryKey = fields[1];

      // Safe checks against missing data corruptions
      if (!hasValue(childPageIdBuffer) || !hasValue(boundaryKey)) {
        continue;
      }

      // Final slot acts as the "infinity/catch-all" bound
      if (index === slotCount - 1) {
        return childPageIdBuffer.readUInt32BE(0);
      }

      // Perform a lexicographical byte comparison
      if (searchKey.compare(boundaryKey) <= 0) {
        return childPageIdBuffer.readUInt32BE(0);
      }
    }

    throw new Error("B+Tree Internal Node routing state is broken: No valid paths found.");
  }
}
