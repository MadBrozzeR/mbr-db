type Shift = -1 | 0 | 1;
type Empty = undefined | null | void;
type BinarySearchCallback<D> = (this: BinarySearch<D>, index: number, data: D) => Shift | Empty;

export class BinarySearch<D = void> {
  low = 0;
  high = 0;
  callback: undefined | BinarySearchCallback<D>;

  constructor(callback?: BinarySearchCallback<D>) {
    callback && this.use(callback);
  }

  use(callback: BinarySearchCallback<D>) {
    this.callback = callback;
    return this;
  }

  setLow(index: number) {
    this.low = Math.max(index, this.low);
  }

  setHight(index: number) {
    this.high = Math.min(index, this.high);
  }

  run(count: number, data: D) {
    if (!this.callback) {
      throw new Error('Callback is not set');
    }

    this.low = -1;
    this.high = count;

    while (this.low < this.high - 1) {
      const middle = (this.low + this.high) >> 1;
      let currentMiddle = middle;
      let result: Shift | Empty;

      while (currentMiddle <= this.high && currentMiddle < count) {
        result = this.callback(currentMiddle, data);
        if (result || result === 0) {
          break;
        }
        currentMiddle++;
      }

      switch (result) {
        case 0:
          return currentMiddle;
        case 1:
          this.low = currentMiddle;
          break;
        default:
          this.high = middle;
      }
    }

    return -1;
  }
}
