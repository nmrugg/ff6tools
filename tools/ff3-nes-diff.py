#!/usr/bin/env python3
"""Diff two NES dumps and emit an IPS patch to make the user's copy
byte-identical to the reference the tool expects.

    usage: ff3-nes-diff.py [mine.nes] [reference.nes] [out.ips]
"""
import zlib, hashlib, sys, os

MINE = sys.argv[1] if len(sys.argv) > 1 else 'Final Fantasy III (Japan).nes'
REF  = sys.argv[2] if len(sys.argv) > 2 else 'Final Fantasy III (Japan) (fixed).nes'
OUT  = sys.argv[3] if len(sys.argv) > 3 else 'patches/ff3j-nes-fix-dump.ips'

a = open(MINE, 'rb').read()
b = open(REF,  'rb').read()

def info(name, d):
    hdr = d[:16]
    prg, chr_ = hdr[4], hdr[5]
    mapper = ((hdr[7] & 0x0F) << 4) | (hdr[6] >> 4)
    print('%-40s size %7d  crc32 %08x  md5 %s' %
          (name, len(d), zlib.crc32(d) & 0xffffffff, hashlib.md5(d).hexdigest().upper()))
    print('    header: %s' % hdr.hex())
    print('    prg16k=%d chr8k=%d mapper=%d mirroring=%d battery=%d' %
          (prg, chr_, mapper, (hdr[6] >> 1) & 1, (hdr[6] >> 1) & 1 and 0 or (hdr[6] & 2) // 2))

info(MINE, a); info(REF, b); print()

diffs = [i for i in range(min(len(a), len(b))) if a[i] != b[i]]
print('differing bytes:', len(diffs))

# group into runs (merging small gaps) for a compact report + patch
runs = []
if diffs:
    s = p = diffs[0]
    for i in diffs[1:]:
        if i <= p + 8:
            p = i; continue
        runs.append((s, p)); s = p = i
    runs.append((s, p))

print('contiguous regions (merged within 8 bytes):', len(runs))
for s, e in runs[:40]:
    print('  0x%06x - 0x%06x (%d bytes)' % (s, e, e - s + 1))
    print('      yours: %s' % a[s:e+1][:24].hex(' '))
    print('      ref  : %s' % b[s:e+1][:24].hex(' '))

# iNES header interpretation
print('\n--- header field comparison ---')
names = {4: 'PRG size (16K units)', 5: 'CHR size (8K units)', 6: 'flags 6', 7: 'flags 7',
         8: 'RAM size (8K units)', 9: 'VRAM size', 10: 'mapper high / vs system', 11: 'misc'}
for i in range(0, 16):
    if a[i] != b[i]:
        print('  header[%d] %s: yours 0x%02x  ref 0x%02x' % (i, names.get(i, ''), a[i], b[i]))

out = bytearray(b'PATCH')
for s, e in runs:
    data = b[s:e+1]
    out += (s >> 16 & 0xFF).to_bytes(1, 'big') + (s & 0xFFFFFF).to_bytes(2, 'big') \
           + len(data).to_bytes(2, 'big') + data
out += b'EOF'
path = OUT
open(path, 'wb').write(bytes(out))
print('\nwrote %s (%d bytes, %d records)' % (path, len(out), len(runs)))

# verify
def apply_ips(rom, ips):
    o = bytearray(rom); i = 5
    while ips[i:i+3] != b'EOF':
        off = int.from_bytes(ips[i:i+3], 'big'); i += 3
        n = int.from_bytes(ips[i:i+2], 'big'); i += 2
        if n == 0:
            rle = int.from_bytes(ips[i:i+2], 'big'); i += 2
            o[off:off+rle] = ips[i:i+1] * rle; i += 1
        else:
            o[off:off+n] = ips[i:i+n]; i += n
    return bytes(o)

p = apply_ips(a, bytes(out))
print('applied -> crc32 %08x  identical to reference: %s' %
      (zlib.crc32(p) & 0xffffffff, p == b))

# what the differing header bytes actually mean
def dec(d):
    f6, f7 = d[6], d[7]
    return dict(
        mapper=((f7 & 0x0F) << 4) | (f6 >> 4),
        mirroring=('horizontal', 'vertical')[(f6 >> 1) & 1] if not (f6 & 1) else ('horizontal', 'vertical')[f6 & 1],
        battery=bool(f6 & 2),
        trainer=bool(f6 & 4),
        four_score=bool(f6 & 8),
        hw_mirroring=bool(f6 & 0x40),
        ines2=bool(d[15] & 0x0C),
    )
print('\n--- header decode ---')
for name, d in (('yours', a), ('reference', b)):
    print('  %-10s %s' % (name, dec(d)))
data_diffs = [d for d in diffs if d >= 16]
print('\n  => %d differing bytes of %d; %s' %
      (len(diffs), len(a),
       'the ROM data itself is identical - only the iNES header differs'
       if not data_diffs else '%d of them are in the ROM data, not just the header' % len(data_diffs)))
print('\n  NOTE: if only the header differs, the dump works fine in ff6tools once')
print('     you pick the right definition manually from the list - the CRC mismatch')
print('     is only the header. Apply the IPS patch to make it auto-detect.')
