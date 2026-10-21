export const PAGE_SIZE = 4096;
export const HEADER_SIZE = 12;
export const SLOT_SIZE = 4;
export const DEFAULT_POOL_COUNT = 20;
export const PAGE_TYPE = {
  META: 0,
  TREE_LEAF: 1,
  TREE_INTERNAL: 2,
  OVERFLOW: 3,
} as const;

export const PAGE_HEADER_MASK = {
  TYPE_MASK: 0b00000111,
  IS_ROOT: 0b10000000,
  IS_COMPACT: 0b01000000,
};
