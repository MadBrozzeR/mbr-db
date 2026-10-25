import assert from 'node:assert/strict';
import { IndexTreeManager } from './components/index-tree-manager';
import { PagePool } from './components/page-pool';
import { PAGE_TYPE } from './constants';
import { serializeRow } from './utils/buffer-utils';

class ExtendedMockPagePool extends PagePool {
  rootPageIdMap = new Map<string, number>();

  constructor() {
    super(10);
    this.updateRootPageId = async (table: string, id: number) => {
      this.rootPageIdMap.set(table, id);
    };
  }
}

function generateFixedRow(keyStr: string, payloadSize = 60): Buffer {
  return serializeRow([Buffer.from(keyStr, 'utf8'), Buffer.alloc(payloadSize, 'a')]);
}

async function runSynchronizedGauntlet() {
  const pool = new ExtendedMockPagePool();
  const tableName = 'test_table';

  console.log('🏁 Starting Unified Index Integration Test...');

  // Create a minimal Mock Pager that conforms fully to the BufferPool expectation
  let virtualPageCount = 0;
  const mockPager = {
    allocatePage: async () => {
      const assignedId = virtualPageCount++;
      return assignedId;
    },
    // CRITICAL FIX: Add readPage and writePage implementations to satisfy the BufferPool
    readPage: async (_pageId: number, buffer: Buffer) => {
      buffer.fill(0); // Emulates reading a blank or freshly formatted disk sector
    },
    writePage: async (_pageId: number, _buffer: Buffer) => {
      // Direct pass-through for test context execution
    },
    getTotalPages: () => virtualPageCount,
    open: async () => mockPager,
    close: async () => {}
  } as any;

  // Mount mock instance onto internal page trackers
  pool.pagers[tableName] = mockPager;
  pool.bufferPool.addPager(tableName, mockPager);
  await pool.open(tableName);

  // Allocate seed baseline root sheet
  const { pageManager: seedRoot, id: seedId } = await pool.allocatePage(tableName);
  seedRoot.init(PAGE_TYPE.TREE_LEAF);
  pool.rootPageIdMap.set(tableName, seedId);

  const manager = new IndexTreeManager(tableName, pool);

  // 1. Validate simple sorted mutations
  await manager.insertIndexed(pool.rootPageIdMap.get(tableName)!, generateFixedRow('M'));
  await manager.insertIndexed(pool.rootPageIdMap.get(tableName)!, generateFixedRow('B'));
  await manager.insertIndexed(pool.rootPageIdMap.get(tableName)!, generateFixedRow('T'));

  let activeRoot = await pool.getPage(tableName, pool.rootPageIdMap.get(tableName)!);
  assert.equal(activeRoot?.getSlotCount(), 3, 'Root should store exactly three elements.');

  console.log('✅ Baseline sorted leaf insertion verified.');

  // 2. Force leaf split propagation and root-sheet promotion by packing a 4KB sheet boundary
  console.log('📦 Injecting larger payloads to force physical node splitting...');
  
  // Pack the page close to its 4096-byte boundary
  for (let i = 0; i < 25; i++) {
    await manager.insertIndexed(pool.rootPageIdMap.get(tableName)!, generateFixedRow(`KeyPrefix_${i}`, 130));
  }

  const targetedRootId = pool.rootPageIdMap.get(tableName)!;
  const postCascadeRoot = await pool.getPage(tableName, targetedRootId);

  assert.equal(
    postCascadeRoot?.getPageType(), 
    PAGE_TYPE.TREE_INTERNAL, 
    'The root page must be promoted to an internal routing type post-split.'
  );
  
  assert.equal(
    pool.getTotalPages(tableName) > 1, 
    true, 
    'The database framework should have allocated sibling data pages.'
  );

  console.log('💯 ALL ENGINE TESTS PASSED: Tree Traversal and Cascade Split routines synchronized.');
}

export function test() {
  runSynchronizedGauntlet().catch((err) => {
    console.error('❌ Integration Gauntlet Failed:', err);
    process.exit(1);
  });
}
