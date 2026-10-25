import { template } from '../utils/string-utils';

export const REASON = {
  PAGE_OUT_OF_SPACE: 'Page overflow: Not enough space to store this record.',
  TABLE_NOT_FOUND: 'Could not find table "${table}" in pager',
  PAGE_WAS_NOT_CREATED: 'Page was not created',
  PAGE_MANAGER_EMPTY: 'PageManager is empty. Set buffer first.',
  DUPLICATE_RECORD_ID: 'Record ID ${id} already exists',
  FIELD_NOT_FOUND: 'Required field not found',
  KEY_NOT_FOUND: 'Could not find row key',
  RECORD_NOT_FOUND: 'Required record not found',
  SIZE_DOES_NOT_MATCH: 'Source row length (${source}) should be equal to target (${target})',
  PAGE_NOT_FOUND: 'Page ${pageId} not found in "${table}" table',
  CANNOT_SPLIT_INTERNAL: 'Cannot split internal tree page with one or no records',
  WRONG_INTERNAL_TREE_KEY: 'Internal tree splitKey has wrong size (${size} instead of 4)',
  TREE_DEPTH_EXCEEDED: 'Tree depth exeeded. Maximum depth is ${depth}',
  ROOT_SPLIT_FAILED: 'Boundary split requires a clean promotion key',
};

type Reason = keyof typeof REASON;

export class AppError extends Error {
  code: Reason;

  static REASON = REASON;

  static check(error: any): error is AppError {
    return (error instanceof AppError);
  }

  static checkReason(error: any, reason: Reason) {
    return this.check(error) && error.code === reason;
  }

  constructor(reason: Reason, data: Record<string, string | number> = {}) {
    super(template(REASON[reason], data));
    this.code = reason;
  }
}
