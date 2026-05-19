/**
 * Low-level binary reader utilities for PZ binary formats.
 * All PZ files use little-endian byte order.
 *
 * Port of pzmap2dzi/util.py read_* functions.
 */

const TEXT_DECODER = new TextDecoder('utf-8');

/** Mutable cursor that advances through an ArrayBuffer. */
export interface Cursor {
    pos: number;
}

/**
 * Read a single unsigned 8-bit integer.
 * Equivalent to Python: struct.unpack('B', data[pos:pos+1])
 */
export function readUint8(view: DataView, cursor: Cursor): number {
    const value = view.getUint8(cursor.pos);
    cursor.pos += 1;
    return value;
}

/**
 * Read an unsigned 16-bit integer (little-endian).
 */
export function readUint16(view: DataView, cursor: Cursor): number {
    const value = view.getUint16(cursor.pos, true);
    cursor.pos += 2;
    return value;
}

/**
 * Read an unsigned 32-bit integer (little-endian).
 * Equivalent to Python: struct.unpack('I', data[pos:pos+4])
 */
export function readUint32(view: DataView, cursor: Cursor): number {
    const value = view.getUint32(cursor.pos, true);
    cursor.pos += 4;
    return value;
}

/**
 * Read a signed 32-bit integer (little-endian).
 * Equivalent to Python: struct.unpack('i', data[pos:pos+4])
 */
export function readInt32(view: DataView, cursor: Cursor): number {
    const value = view.getInt32(cursor.pos, true);
    cursor.pos += 4;
    return value;
}

/**
 * Read `length` raw bytes and return them as a Uint8Array view.
 */
export function readBytes(view: DataView, cursor: Cursor, length: number): Uint8Array {
    const slice = new Uint8Array(view.buffer, view.byteOffset + cursor.pos, length);
    cursor.pos += length;
    return slice;
}

/**
 * Read a newline-terminated string (not including the '\n').
 * Port of Python: util.read_line(data, pos)
 *
 * PZ tile defs are stored as UTF-8 text lines terminated by '\n' (0x0A).
 */
export function readLine(view: DataView, cursor: Cursor): string {
    const start = cursor.pos;
    const buf = new Uint8Array(view.buffer, view.byteOffset);
    let end = start;
    while (end < buf.length && buf[end] !== 0x0a) {
        end++;
    }
    // end now points to '\n' — include it in consumed bytes
    const lineBytes = new Uint8Array(view.buffer, view.byteOffset + start, end - start);
    cursor.pos = end + 1; // skip past '\n'
    // Strip trailing '\r' if present (Windows line endings in some PZ files)
    const str = TEXT_DECODER.decode(lineBytes);
    return str.endsWith('\r') ? str.slice(0, -1) : str;
}

/**
 * Read a uint32 length-prefixed UTF-8 string.
 * Port of Python: util.read_bytes_with_length(data, pos) + decode
 *
 * Format: [uint32 length][length bytes UTF-8]
 */
export function readLengthPrefixedString(view: DataView, cursor: Cursor): string {
    const length = readUint32(view, cursor);
    if (length === 0) {
        return '';
    }
    const bytes = readBytes(view, cursor, length);
    return TEXT_DECODER.decode(bytes);
}

/**
 * Read exactly `length` bytes and return them as a new ArrayBuffer copy.
 * Useful when you need to pass a slice to another DataView.
 */
export function readBytesCopy(view: DataView, cursor: Cursor, length: number): ArrayBuffer {
    const slice = (view.buffer as ArrayBuffer).slice(
        view.byteOffset + cursor.pos,
        view.byteOffset + cursor.pos + length,
    );
    cursor.pos += length;
    return slice;
}

/**
 * Check that the next `magic.length` bytes match `magic`.
 * Advances cursor past magic bytes on success.
 * Returns true if magic matched.
 */
export function checkMagic(view: DataView, cursor: Cursor, magic: Uint8Array): boolean {
    const buf = new Uint8Array(view.buffer, view.byteOffset);
    for (let i = 0; i < magic.length; i++) {
        if (buf[cursor.pos + i] !== magic[i]) {
            return false;
        }
    }
    cursor.pos += magic.length;
    return true;
}

/**
 * Peek at the next `count` bytes without advancing cursor.
 */
export function peekBytes(view: DataView, cursor: Cursor, count: number): Uint8Array {
    return new Uint8Array(view.buffer, view.byteOffset + cursor.pos, count);
}

/**
 * Returns total byte length of the DataView's underlying buffer.
 */
export function byteLength(view: DataView): number {
    return view.byteLength;
}

/**
 * Assert that the cursor has not overflowed the buffer.
 * Throws a RangeError with a descriptive message if it has.
 */
export function assertInBounds(view: DataView, cursor: Cursor, context: string): void {
    if (cursor.pos > view.byteLength) {
        throw new RangeError(
            `[pz-binary] Read past end of buffer at pos=${cursor.pos} (size=${view.byteLength}) in ${context}`,
        );
    }
}
