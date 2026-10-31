export function replaceItem<T>(array: T[], newItem: T, index: number) {
  if (newItem === array[index]) {
    return array;
  }

  const newArray: T[] = [];
  newArray.push.apply(newArray, array);
  newArray[index] = newItem;

  return newArray;
}
