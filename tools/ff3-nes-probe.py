#!/usr/bin/env python3
"""Investigate FF3 (Japan) Famicom ROM: what the tool models, what it does not,
and where the missing battle/monster graphics plausibly live."""
import json, zlib, hashlib, math, sys

ROM = 'Final Fantasy III (Japan).nes'
data = open(ROM, 'rb').read()
hdr = data[:16]
prg = data[16:16 + hdr[4] * 16384]
chr_len = hdr[5] * 8192

print('file        :', ROM)
print('size        :', len(data))
print('crc32       : %08x' % (zlib.crc32(data) & 0xffffffff))
print('md5         :', hashlib.md5(data).hexdigest().upper())
print('mapper      :', ((hdr[7] << 4) | (hdr[6] >> 4)))
print('PRG banks   :', hdr[4], '(=%d KiB)' % (hdr[4] * 16), ' CHR ROM banks:', hdr[5])
print()

ref = json.load(open('ff3/ff3j-nes.json'))
print('supported ff3j-nes.json expects crc32', ref['crc32'], 'length', ref['length'])
match = ('0x%08X' % (zlib.crc32(data) & 0xffffffff)).upper() == ref['crc32'].upper()
print('this dump matches that definition:', match)
print()

keys = list(ref['assembly'].keys())
print('assemblies in the definition (%d):' % len(keys))
for k in keys:
    a = ref['assembly'][k]
    t = a.get('type', '?')
    r = a.get('range', a.get('begin', ''))
    print('   %-24s %-12s %s' % (k, t, r))
print()
print('=> no monster/battle/character graphics assemblies exist for this game.')
print()

for k in ('mapGraphics', 'worldGraphics', 'worldGraphicsCommon', 'mapTileset'):
    a = ref['assembly'].get(k)
    if a:
        print(k, '->', json.dumps(a)[:400])
print()

# entropy map: graphics data is dense/high-entropy, code is mid, padding is low
BLK = 0x4000
print('PRG entropy per %d KiB block (looking for packed tile data):' % (BLK // 1024))
rows = []
for i in range(0, len(prg), BLK):
    chunk = prg[i:i + BLK]
    if len(chunk) < BLK:
        break
    freq = [0] * 256
    for b in chunk:
        freq[b] += 1
    ent = -sum((c / len(chunk)) * math.log2(c / len(chunk)) for c in freq if c)
    zero = freq[0] / len(chunk)
    ff = freq[0xFF] / len(chunk)
    rows.append((i, ent, zero, ff))
for i, ent, zero, ff in rows:
    bar = '#' * int(ent * 8)
    flag = ''
    if zero > 0.5 or ff > 0.5:
        flag = '  <- padding'
    elif ent > 7.0:
        flag = '  <- high entropy (compressed or tile data)'
    print('  0x%05x  ent %5.2f  zero %4.2f  ff %4.2f  %s%s' % (i, ent, zero, ff, bar, flag))
