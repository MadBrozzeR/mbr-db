import { HEADER_SIZE, SLOT_SIZE } from '../constants';

const DATA_TEXT_MAX_LEN = 64;

export function debugPage (buffer: Buffer | null | undefined) {
  if (!buffer) {
    console.log('NULL');
    return;
  }

  const header = buffer.readUInt16BE(0);
  const slotCount = buffer.readUInt16BE(2);
  const freeSpacePointer = buffer.readUInt16BE(4);
  const deletedBytes = buffer.readUInt16BE(6);
  const nextPageId = buffer.readUInt16BE(8);
  const slotArguments: string[] = ['\nSLOTS:'];
  const records: Record<string, string> = {};
  const recordArguments = ['\nRECORDS:'];

  for (let index = 0 ; index < slotCount ; ++index) {
    const slotOffset = HEADER_SIZE + SLOT_SIZE * index;
    const dataOffset = buffer.readUInt16BE(slotOffset);
    const dataOffsetHex = '0x' + dataOffset.toString(16);
    const dataLength = buffer.readUInt16BE(slotOffset + 2);
    const data = buffer.subarray(dataOffset, dataOffset + dataLength);
    const dataText = dataLength > DATA_TEXT_MAX_LEN
      ? data.subarray(0, DATA_TEXT_MAX_LEN).toString('hex') + ` (+${dataLength - DATA_TEXT_MAX_LEN})`
      : data.toString('hex');
    slotArguments.push(`[${dataOffsetHex}:${dataLength}]`);
    records[dataOffset] = (`\n${dataOffsetHex}:  ${dataText}`);
  }

  for (const offset in records) if (records[offset]) {
    recordArguments.push(records[offset]);
  }

  console.log('HEADER:', header);
  console.log('SLOT_COUNT:', slotCount);
  console.log('FREE_SPACE_POINTER:', '0x' + freeSpacePointer.toString(16));
  console.log('NEXT_PAGE_ID:', nextPageId);
  console.log('DELETED_BYTES:', deletedBytes);
  console.log.apply(console, slotArguments);
  console.log.apply(console, recordArguments);
}
