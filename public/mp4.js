// Minimal MP4 (ISO BMFF) writer for one H.264 video track from WebCodecs EncodedVideoChunks.
// Constant frame rate, one chunk, no B-frames (Baseline profile), so no ctts/edit lists are needed.
const ascii = text => [...text].map(c => c.charCodeAt(0));
function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function u16(n) { return [(n >>> 8) & 255, n & 255]; }
function concat(parts) {
  const size = parts.reduce((sum, p) => sum + p.length, 0), out = new Uint8Array(size); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
function box(type, ...parts) {
  const body = concat(parts.map(p => p instanceof Uint8Array ? p : Uint8Array.from(p)));
  return concat([Uint8Array.from([...u32(body.length + 8), ...ascii(type)]), body]);
}
const full = (type, version, flags, ...parts) => box(type, [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...parts);
// Identity transform in 16.16 / 2.30 fixed point.
function matrix() { return [...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)]; }
// chunks: [{ data: Uint8Array, key: boolean }] in decode order; description: avcC bytes from decoderConfig.
export function muxMp4({ width, height, fps, chunks, description }) {
  const timescale = fps * 1000, delta = 1000, count = chunks.length, durationMs = Math.round(count * 1000 / fps);
  const moov = offset => box('moov',
    full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(durationMs), u32(0x00010000), u16(0x0100), new Array(10).fill(0), matrix(), new Array(24).fill(0), u32(2)),
    box('trak',
      full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(durationMs), new Array(8).fill(0), u16(0), u16(0), u16(0), u16(0), matrix(), u32(width << 16), u32(height << 16)),
      box('mdia',
        full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(count * delta), u16(0x55c4), u16(0)),
        full('hdlr', 0, 0, u32(0), ascii('vide'), new Array(12).fill(0), ascii('VideoHandler'), [0]),
        box('minf',
          full('vmhd', 0, 1, new Array(8).fill(0)),
          box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
          box('stbl',
            full('stsd', 0, 0, u32(1), box('avc1', new Array(6).fill(0), u16(1), new Array(16).fill(0), u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), new Array(32).fill(0), u16(0x0018), u16(0xffff), box('avcC', description))),
            full('stts', 0, 0, u32(1), u32(count), u32(delta)),
            full('stss', 0, 0, u32(chunks.filter(c => c.key).length), ...chunks.flatMap((c, i) => c.key ? [u32(i + 1)] : [])),
            full('stsc', 0, 0, u32(1), u32(1), u32(count), u32(1)),
            full('stsz', 0, 0, u32(0), u32(count), ...chunks.map(c => u32(c.data.length))),
            full('stco', 0, 0, u32(1), u32(offset)))))));
  const ftyp = box('ftyp', ascii('isom'), u32(512), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'));
  const size = moov(0).length, payload = concat(chunks.map(c => c.data));
  const mdat = concat([Uint8Array.from([...u32(payload.length + 8), ...ascii('mdat')]), payload]);
  return new Blob([ftyp, moov(ftyp.length + size + 8), mdat], { type: 'video/mp4' });
}
