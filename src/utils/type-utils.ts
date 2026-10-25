import { PAGE_TYPE } from '../constants';

export function hasValue<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

export function isValueOf<T extends {}>(value: any, object: T): value is T[keyof T] {
  for (const key in object) if (object[key] === value) {
    return true;
  }

  return false;
}

export function assertPageType(value: number) {
  if (isValueOf(value, PAGE_TYPE)) {
    return value;
  }

  throw new Error('Wrong page type');
}
