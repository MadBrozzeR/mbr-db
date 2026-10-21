import { template } from '../utils/string-utils';

export const REASON = {
  PAGE_OUT_OF_SPACE: 'Page overflow: Not enough space to store this record.',
  TABLE_NOT_FOUND: 'Could not find this table in pager',
  PAGE_WAS_NOT_CREATED: 'Page was not created',
  PAGE_MANAGER_EMPTY: 'PageManager is empty. Set buffer first.',
  DUPLICATE_RECORD_ID: 'Record ID ${id} already exists'
};

type Reason = keyof typeof REASON;

export class ControlledError extends Error {
  reason: Reason;

  static REASON = REASON;

  static check(error: any): error is ControlledError {
    return (error instanceof ControlledError);
  }

  static checkReason(error: any, reason: Reason) {
    return this.check(error) && error.reason === reason;
  }

  constructor(reason: Reason, data: Record<string, string> = {}) {
    super(template(REASON[reason], data));
    this.reason = reason;
  }
}
