import assert from 'node:assert/strict';
import { PageManager } from './components/page-manager'; // Adjust paths as necessary
import { serializeRow } from './utils/buffer-utils';
import { PAGE_SIZE } from './constants';

// Mock Cache Frame to observe dirty state mutations natively
const mockCacheFrame = {
  table: 'test_table',
  pageId: 0,
  buffer: Buffer.alloc(PAGE_SIZE),
  isDirty: false
};

/**
 * Helper to generate a dummy data payload with an explicit sorted index key string
 */
function makeMockRow(keyString: string, valueLength = 20): Buffer {
  const keyBuffer = Buffer.from(keyString, 'utf8');
  const valueBuffer = Buffer.alloc(valueLength, 'x'); // Dummy payload filler
  return serializeRow([keyBuffer, valueBuffer]);
}

async function runPageManagerTests() {
  console.log('🚀 INITIALISING GAUNTLET: TESTING COMPRESSED SLOTTED PAGE ORDERING...\n');

  const manager = new PageManager(mockCacheFrame.buffer, mockCacheFrame);

  // Test Scenario 1: Clean slate layout formation
  manager.init(1); // PAGE_TYPE.LEAF
  assert(manager.getSlotCount() === 0, 'Slot count should start at exactly 0');
  assert(manager.getAvailableFreeSpace() === PAGE_SIZE - 12, 'Empty page should have max free space minus header size');
  console.log('✅ Scenario 1 Passed: Slotted initialization structure verified.');

  // Test Scenario 2: Strict sorted sequence injection out-of-order
  // Inserting: "M", "A", "Z", "C" -> Expected order: "A", "C", "M", "Z"
  const rowM = makeMockRow('M');
  const rowA = makeMockRow('A');
  const rowZ = makeMockRow('Z');
  const rowC = makeMockRow('C');

  manager.insertSortedRow(rowM); // Becomes index 0
  manager.insertSortedRow(rowA); // Shifts M, becomes index 0
  manager.insertSortedRow(rowZ); // Appends at index 2
  manager.insertSortedRow(rowC); // Shifts M & Z, slips into index 1

  assert(manager.getSlotCount() === 4, 'Should possess 4 active slot frames');
  console.log('✅ Scenario 2 Passed: Records injected and slot arrays shifted cleanly.');

  // Test Scenario 3: Verify O(log N) point lookup alignments
  const foundA = manager.findKey(Buffer.from('A', 'utf8'));
  const foundM = manager.findKey(Buffer.from('M', 'utf8'));
  const foundX = manager.findKey(Buffer.from('X', 'utf8')); // Non-existent key edge case

  assert(foundA !== null, 'Key "A" must be resolved successfully');
  assert(foundM !== null, 'Key "M" must be resolved successfully');
  assert(foundX === null, 'Searching for key "X" must safely return null');
  console.log('✅ Scenario 3 Passed: Point-lookup query routines confirmed accurate.');

  // Test Scenario 4: Soft-deletion and Hole-Resilient Interval Binary Searching
  // Let's drop row "C" which sits squarely at index 1 to form an empty array gap
  const deleteSuccess = manager.deleteRow(1);
  assert(deleteSuccess === true, 'Soft deletion of slot index 1 should execute cleanly');
  assert(manager.getRow(1) === null, 'Slot 1 must now resolve as a dead row hole');
  assert(manager.getDeletedBytes() > 0, 'Fragmentation counters must track bytes reclaimed');

  // Verify search engine can skip the hole at index 1 to hit key "M" safely
  const foundMAfterDelete = manager.findKey(Buffer.from('M', 'utf8'));
  assert(foundMAfterDelete !== null, 'Hole-skipping loop failed to hop deleted gap to resolve key "M"');
  console.log('✅ Scenario 4 Passed: Hole routing and soft-deletions operate without regression.');

  // ===========================================================================
  // Test Scenario 5: Mathematical verification of lazy-defragmentation
  // ===========================================================================
  
  // 1. Try to inject an impossibly massive row to verify out-of-space guard limits
  const massiveRow = makeMockRow('B', 5900); 
  try {
    manager.insertSortedRow(massiveRow);
    // If it doesn't throw, manually trigger a failure
    assert.fail('Should have thrown PAGE_OUT_OF_SPACE');
  } catch (error: any) {
    if (error.name === 'AssertionError') throw error; // Pass through test failures
    assert.equal(error.reason, 'PAGE_OUT_OF_SPACE');
    console.log('✅ Scenario 5a Passed: Lazy boundary protection caught buffer overflow safely.');
  }

  // 2. Dynamically exhaust the contiguous space using the live manager state.
  // Calculate exactly how much room we need to leave behind to trigger a lazy compaction
  const rowB = makeMockRow('B'); // Target row size we want to fit later (~27 bytes)
  const requiredForB = 4 + rowB.length; // Slot size + payload
  
  // Leave just enough space where B cannot fit cleanly without defragmenting
  const targetContiguousSpace = requiredForB - 10; 
  const currentContiguousFree = manager.getAvailableFreeSpace();
  
  // Back-calculate the precise payload footprint needed for the filler row
  const totalFillerAllocationNeeded = currentContiguousFree - targetContiguousSpace;
  const fillerPayloadLength = totalFillerAllocationNeeded - 4 - 2 - 3; // accounting for slot + field headers
  
  const fillerRow = makeMockRow('F', fillerPayloadLength);
  manager.insertSortedRow(fillerRow);

  // 3. This insert requires more contiguous space than what's left,
  // but it fits once the soft-deleted hole is cleared. This forces defragmentation!
  manager.insertSortedRow(rowB); 
  
  // Verify that lazy defragmentation actually executed
  assert.equal(manager.getDeletedBytes(), 0);
  assert.notEqual(manager.findKey(Buffer.from('B', 'utf8')), null);

  console.log('✅ Scenario 5b Passed: Lazy compaction triggered naturally and cleared internal fragmentation.');
  console.log('\n💯 ALL ENGINE VERIFICATION SCRIPTS SECURED: 100% OPERATIONAL SANITY CONTEXT.');
}

export const test = () => {
  runPageManagerTests().catch((err) => {
    console.error('\n❌ CRITICAL STRUCTURAL REGRESSION DETECTED:');
    console.error(err);
    process.exit(1);
  });
};
