import path from 'node:path';
import { DEFAULT_POOL_COUNT } from '../constants';
import { PagePool } from './page-pool';
import { TableAccessor } from './table-accessor';

export class Database {
  private directoryPath: string;
  private pagePool: PagePool;
  private tables = new Map<string, TableAccessor>();

  constructor(directoryPath: string, maxCachePages = DEFAULT_POOL_COUNT) {
    this.directoryPath = directoryPath;
    this.pagePool = new PagePool(maxCachePages);
  }

  /**
   * Dynamically mounts a table into our active storage engine context.
   */
  async openTable(tableName: string): Promise<TableAccessor> {
    if (this.tables.has(tableName)) {
      return this.tables.get(tableName)!;
    }

    const targetFilePath = path.join(this.directoryPath, tableName + '.db');
    await this.pagePool.setPager(tableName, targetFilePath);

    const accessor = new TableAccessor(tableName, this.pagePool);
    await accessor.init();
    this.tables.set(tableName, accessor);
    return accessor;
  }

  /**
   * Returns a reference to an already opened table channel.
   */
  table(tableName: string): TableAccessor {
    const accessor = this.tables.get(tableName);
    if (!accessor) {
      throw new Error(`Table '${tableName}' has not been opened. Run await db.openTable('${tableName}') first.`);
    }
    return accessor;
  }

  /**
   * Persists all data across all tables and safely releases all OS locks.
   */
  async close(): Promise<void> {
    await this.pagePool.flush();
    await this.pagePool.closeAll();
    this.tables.clear();
  }
}
