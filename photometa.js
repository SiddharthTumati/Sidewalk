// Removes hidden metadata (EXIF, GPS location, XMP, comments) from uploaded photos
// without re-encoding them. The browser already redraws photos, which drops this data;
// this is a server-side guarantee in case a photo arrives some other way.

// JPEG: drop APP1 (EXIF/XMP), APP3–APP15, and comment segments. Keep APP0 (JFIF) and
// APP2 (color profile), which don't contain personal data.
function stripJpeg(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('bad jpeg');
  const parts = [buf.subarray(0, 2)];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error('bad jpeg marker');
    let j = i;
    while (buf[j] === 0xff) j += 1; // fill bytes
    const marker = buf[j];
    if (marker === 0xda) { parts.push(buf.subarray(i)); return Buffer.concat(parts); } // image data starts
    if (marker === 0xd9) { parts.push(buf.subarray(i, j + 1)); return Buffer.concat(parts); }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { parts.push(buf.subarray(i, j + 1)); i = j + 1; continue; }
    if (j + 2 >= buf.length) throw new Error('truncated jpeg');
    const length = buf.readUInt16BE(j + 1);
    const end = j + 1 + length;
    if (length < 2 || end > buf.length) throw new Error('truncated jpeg');
    const drop = marker === 0xe1 || (marker >= 0xe3 && marker <= 0xef) || marker === 0xfe;
    if (!drop) parts.push(buf.subarray(i, end));
    i = end;
  }
  throw new Error('jpeg has no image data');
}

// PNG: drop text, EXIF, and timestamp chunks.
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
function stripPng(buf) {
  const parts = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const length = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + length;
    if (end > buf.length) throw new Error('truncated png');
    if (!PNG_DROP.has(type)) parts.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(parts);
  }
  throw new Error('png has no end');
}

// WebP: drop EXIF and XMP chunks and clear their flags in the VP8X header.
function stripWebp(buf) {
  const chunks = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    const fourcc = buf.toString('latin1', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const end = i + 8 + size + (size % 2);
    if (i + 8 + size > buf.length) throw new Error('truncated webp');
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      let chunk = buf.subarray(i, Math.min(end, buf.length));
      if (fourcc === 'VP8X' && size >= 1) {
        chunk = Buffer.from(chunk);
        chunk[8] &= ~(0x08 | 0x04); // EXIF and XMP flags
      }
      chunks.push(chunk);
    }
    i = end;
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.from(buf.subarray(0, 12));
  header.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([header, body]);
}

function stripPhotoMetadata(mime, data) {
  if (mime === 'image/jpeg') return stripJpeg(data);
  if (mime === 'image/png') return stripPng(data);
  if (mime === 'image/webp') return stripWebp(data);
  return data;
}

module.exports = { stripPhotoMetadata };
