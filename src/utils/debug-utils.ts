import { Pager } from '../components/pager';
import { HEADER_SIZE, SLOT_SIZE } from '../constants';

const DATA_TEXT_MAX_LEN = 64;

export function debugPage (buffer: Buffer | null | undefined) {
  let result = '';
  if (!buffer) {
    result = 'NULL';
    return;
  }

  const header = buffer.readUInt16BE(0);
  const slotCount = buffer.readUInt16BE(2);
  const freeSpacePointer = buffer.readUInt16BE(4);
  const deletedBytes = buffer.readUInt16BE(6);
  const nextPageId = buffer.readUInt32BE(8);
  let slotArguments = '\nSLOTS: ';
  const records: Record<string, string> = {};
  let recordArguments = '\nRECORDS: ';

  for (let index = 0 ; index < slotCount ; ++index) {
    const slotOffset = HEADER_SIZE + SLOT_SIZE * index;
    const dataOffset = buffer.readUInt16BE(slotOffset);
    const dataOffsetHex = '0x' + dataOffset.toString(16);
    const dataLength = buffer.readUInt16BE(slotOffset + 2);
    const data = buffer.subarray(dataOffset, dataOffset + dataLength);
    const dataText = dataLength > DATA_TEXT_MAX_LEN
      ? data.subarray(0, DATA_TEXT_MAX_LEN).toString('hex') + ` (+${dataLength - DATA_TEXT_MAX_LEN})`
      : data.toString('hex');
    slotArguments += `[${dataOffsetHex}:${dataLength}]`;
    records[dataOffset] = (`\n${dataOffsetHex}: ${dataText}`);
  }

  for (const offset in records) if (records[offset]) {
    recordArguments += records[offset];
  }

  result += 'HEADER: ' + header + '\n';
  result += 'SLOT_COUNT: ' + slotCount + '\n';
  result += 'FREE_SPACE_POINTER: ' + '0x' + freeSpacePointer.toString(16) + '\n';
  result += 'NEXT_PAGE_ID: ' + nextPageId + '\n';
  result += 'DELETED_BYTES: ' + deletedBytes + '\n';
  result += slotArguments + '\n';
  result += recordArguments + '\n';

  return result;
}

export class PagerDebug {
  pager: Pager;
  isOpen = false;

  constructor(fileName: string) {
    this.pager = new Pager(fileName);
  }

  async showPage(id: number) {
    if (!this.isOpen) {
      await this.pager.open();
      this.isOpen = true;
    }
    try {
      const buffer = await this.pager.readPage(id);
      console.log('Page: ', id);
      console.log(debugPage(buffer)?.replace(/(\n|^)/g, '$1  '));
    } catch (error) {
      console.log('No page', id);
    }
  }
}
