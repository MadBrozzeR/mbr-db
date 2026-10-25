import { AppError } from './errors';

/**
 * Deserializes a single isolated row chunk.
 * Returns an array where each item is either a Buffer (present) or null (missing entirely).
 */
export function deserializeRow(rowBuffer: Buffer, fieldCount = -1): (Buffer | null)[] {
  const fields: Array<Buffer | null> = [];
  let offset = 0;

  // The loop terminates safely when it consumes exactly the rowBuffer's isolated length
  while (fieldCount-- !== 0 && offset < rowBuffer.length) {
    const header = rowBuffer.readUInt8(offset);
    offset += 1;

    // Check Bit 7 (10000000) for presence
    const isPresent = (header & 0x80) !== 0;

    if (!isPresent) {
      fields.push(null);
      continue;
    }

    // Extract Bits 0-6 (01111111) for length grade
    const grade = header & 0x7F;
    let dataLength = 0;

    if (grade <= 124) {
      dataLength = grade;
    } else if (grade === 125) {
      dataLength = rowBuffer.readUInt8(offset);
      offset += 1;
    } else if (grade === 126) {
      dataLength = rowBuffer.readUInt16BE(offset);
      offset += 2;
    } else if (grade === 127) {
      dataLength = rowBuffer.readUInt32BE(offset);
      offset += 4;
    }

    // Extract only this column's bytes
    const fieldData = rowBuffer.subarray(offset, offset + dataLength);
    fields.push(fieldData);

    offset += dataLength;
  }

  return fields;
}

/**
 * Serializes an array of field buffers/nulls into a single packed row buffer.
 */
export function serializeRow(fields: Array<Buffer | null>): Buffer {
  const chunks: Buffer[] = [];
  let totalLength = 0;

  for (const field of fields) {
    let header: Buffer | null = null;

    if (field === null) {
      // Bit 7 is 0 (Not Present)
      header = Buffer.alloc(1);
      header.writeUInt8(0x00, 0);
      chunks.push(header);
      totalLength += header.length;
      continue;
    }

    const length = field.length;

    if (length <= 124) {
      // 1-byte header: Bit 7 set to 1, remaining bits = length
      header = Buffer.alloc(1);
      header.writeUInt8(0x80 | length, 0);
    } else if (length <= 255) {
      // Grade 125 + 1 extra byte
      header = Buffer.alloc(2);
      header.writeUInt8(0x80 | 125, 0);
      header.writeUInt8(length, 1);
    } else if (length <= 65535) {
      // Grade 126 + 2 extra bytes
      header = Buffer.alloc(3);
      header.writeUInt8(0x80 | 126, 0);
      header.writeUInt16BE(length, 1);
    } else {
      // Grade 127 + 4 extra bytes
      header = Buffer.alloc(5);
      header.writeUInt8(0x80 | 127, 0);
      header.writeUInt32BE(length, 1);
    }

    chunks.push(header, field);
    totalLength += header.length + field.length;
  }

  return Buffer.concat(chunks, totalLength);
}

export function getKeyFromRow(rowBuffer: Buffer) {
  const key = deserializeRow(rowBuffer, 1)[0];
  if (!key) {
    throw new AppError('KEY_NOT_FOUND');
  }
  return key;
}

export function getChildId (id: number | Buffer) {
  if (typeof id === 'number') {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt32BE(id);
    return buffer;
  }

  if (id.length !== 4) {
    throw new AppError('WRONG_FIELD_SIZE', { size: id.length, required: 4 });
  }

  return id;
}
