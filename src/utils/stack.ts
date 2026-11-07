export class Stack<T> {
  stack: T[] = [];

  push(item: T) {
    this.stack.push(item);
  }

  clear() {
    this.stack = [];
  }

  isLongerThen(max: number) {
    return this.stack.length > max;
  }

  last() {
    return this.stack[this.stack.length - 1];
  }

  [Symbol.iterator]() {
    let current = this.stack.length - 1;
    const stack = this.stack;

    return {
      next(): { value: T, done: false } | { done: true } {
        if (current < 0) return { done: true };
        const value = stack[current--];
        return value === undefined ? this.next() : { value, done: false };
      }
    };
  }
}
