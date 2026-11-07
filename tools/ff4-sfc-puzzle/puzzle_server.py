#!/usr/bin/env python3
"""Local server for arranging FF4 (U) SNES summon/boss tile puzzles.

Every summon and boss layout now comes out of the ROM (the boss tile maps and
the SummonTilemap OBJ-VRAM placement), so this tool is for *tuning*: the grid
starts with the ROM's arrangement and the tray holds the object's tiles, and
the saved placement overrides the generator on the next definition run.
(The one arrangement the US ROM does not contain, Mom Bomb's full sheet, is
baked in tools/ff4-sfc-names.py and verified by tools/ff4-sfc-artcheck.py.)

Serves puzzle.html and a JSON API:
  GET  /                       -> puzzle.html
  GET  /api/entries            -> [{key,name,cols,rows,tiles,palette,layout}]
  GET  /api/entry/<key>        -> one entry
  POST /api/placement          -> {key, cols, rows, placement:[{cell,tile}]}
                                  saves to placements/<key>.json
  POST /api/delete_placement   -> {key}   removes that placement (ROM layout wins)

Run:  python3 tools/ff4-sfc-puzzle/puzzle_server.py [--def ff4/ff2u-sfc.json]
                                                      [--rom "Final Fantasy II (USA).sfc"]
      then open http://localhost:8139
"""
import argparse, json, os, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
PLACEMENTS = os.path.join(HERE, 'placements')
os.makedirs(PLACEMENTS, exist_ok=True)

# entries offered first when arranging by hand: the five summon-only blocks
# and Mom Bomb (the only arrangement the US ROM does not contain). After these
# the server offers EVERY summonGraphics_* / bossGraphics_* in the definition,
# so any layout can be tuned by hand - a saved placement overrides the
# generator for that key.
PUZZLE_KEYS = ['summonGraphics_Chocobo', 'summonGraphics_Shiva',
               'summonGraphics_Ramuh', 'summonGraphics_Ifrit',
               'summonGraphics_Sylph', 'bossGraphics_36']

def loROM_map(a):
    return ((a & 0xFF0000) >> 1) + (a & 0x7FFF)

def parse_range(rng):
    b, e = rng.split('-')
    return loROM_map(int(b, 16)), loROM_map(int(e, 16))

class Data:
    def __init__(self, defpath, rompath):
        self.defj = json.load(open(defpath))
        self.rom = open(rompath, 'rb').read()
        self.asm = self.defj['assembly']

    def palbytes(self, entry):
        # first palette pin -> monsterPalette[p] -> the game reads 32 bytes
        # at p*16 (sub-palette pair)
        pal = entry.get('palette')
        if isinstance(pal, list):
            first = pal[0]
            if isinstance(first, list):
                first = first[0]
            path = first.get('path', '') if isinstance(first, dict) else str(first)
            if '[' in path:
                p = int(path.split('[')[1].rstrip(']'))
                base = parse_range(self.asm['monsterPalette']['range'])[0]
                cols = []
                for c in range(16):
                    v = self.rom[base + p*16 + c*2] | (self.rom[base + p*16 + c*2 + 1] << 8)
                    cols.append([v & 0x1f, (v >> 5) & 0x1f, (v >> 10) & 0x1f])
                return cols
        return [[31, 31, 31]] * 16

    def tiles_of(self, entry):
        # the block/pool the entry reads: its own range, or the window path's
        if 'range' in entry:
            lo, hi = parse_range(entry['range'])
        else:
            w = entry.get('window', {})
            path = w.get('path', '')
            src = self.asm.get(path)
            if src and 'range' in src:
                lo, hi = parse_range(src['range'])
            elif '_' in path and path.rsplit('_', 1)[1].isdigit():
                # a fragment of a fragmented array: resolve via itemRanges
                arrname, idx = path.rsplit('_', 1)
                arr = self.asm.get(arrname) or {}
                irs = arr.get('itemRanges') or []
                if int(idx) < len(irs):
                    lo, hi = parse_range(irs[int(idx)])
                else:
                    return None
            else:
                return None
        fmt = entry.get('format', 'snes3bpp')
        stride = 24 if fmt == 'snes3bpp' else 32
        out = []
        n = (hi - lo) // stride
        # a window only sees the tiles its definition asks for
        win = entry.get('window') or {}
        if win.get('tiles'):
            n = min(n, int(win['tiles']))
        for t in range(n):
            p = self.rom[lo + t*stride: lo + (t+1)*stride]
            mat = []
            for y in range(8):
                row = []
                for x in range(8):
                    b = 7 - x
                    v = ((p[y*2] >> b) & 1) | (((p[y*2+1] >> b) & 1) << 1) | \
                        (((p[16+y] >> b) & 1) << 2)
                    if stride == 32:
                        v |= (((p[17+y] >> b) & 1) << 3)
                    row.append(v)
                mat.append(row)
            out.append(mat)
        return out

    def entry(self, key):
        e = dict(self.asm.get(key) or {})
        tiles = self.tiles_of(e)
        if tiles is None:
            return None
        return {
            'key': key,
            'name': e.get('name', key),
            'cols': e.get('width', 8),
            'rows': e.get('height', (len(tiles) + 7) // 8),
            'tiles': tiles,
            'palette': self.palbytes(e),
            'layout': e.get('layout', [-1] * (e.get('width', 8) * e.get('height', 8))),
            'placed': os.path.exists(os.path.join(PLACEMENTS, key + '.json')),
        }

D = None

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body, ctype='application/json'):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        p = self.path.split('?')[0]
        if p in ('/', '/index.html', '/puzzle.html'):
            try:
                return self._send(200, open(os.path.join(HERE, 'puzzle.html'), 'rb').read(), 'text/html')
            except OSError:
                return self._send(500, {'error': 'puzzle.html missing'})
        if p == '/api/entries':
            # the hand-picked keys first, then every other assembled view the
            # definition has, so any of them can be re-arranged by hand
            keys = list(PUZZLE_KEYS)
            keys += [k for k in sorted(D.asm)
                     if (k.startswith('summonGraphics_') or k.startswith('bossGraphics_'))
                     and k not in keys]
            return self._send(200, [D.entry(k) for k in keys if k in D.asm])
        if p.startswith('/api/entry/'):
            key = p.rsplit('/', 1)[1]
            e = D.entry(key)
            return self._send(200, e) if e else self._send(404, {'error': f'no {key}'})
        return self._send(404, {'error': 'not found'})
    def _read_body(self):
        n = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(n))
    def do_POST(self):
        p = self.path.split('?')[0]
        if p == '/api/placement':
            o = self._read_body()
            key = o['key']
            if not key.replace('_', '').isalnum():
                return self._send(400, {'error': 'bad key'})
            fp = os.path.join(PLACEMENTS, key + '.json')
            json.dump(o, open(fp, 'w'), indent=1)
            return self._send(200, {'saved': fp})
        if p == '/api/delete_placement':
            o = self._read_body()
            key = o['key']
            if not key.replace('_', '').isalnum():
                return self._send(400, {'error': 'bad key'})
            fp = os.path.join(PLACEMENTS, key + '.json')
            try:
                os.remove(fp)
                return self._send(200, {'deleted': fp})
            except OSError:
                return self._send(404, {'error': f'no placement for {key}'})
        return self._send(404, {'error': 'not found'})

def main():
    global D
    ap = argparse.ArgumentParser()
    ap.add_argument('--def', dest='definition', default=os.path.join(ROOT, 'ff4/ff2u-sfc.json'))
    ap.add_argument('--rom', default='/storage/romhacking/ff-roms/Final Fantasy II (USA).sfc')
    ap.add_argument('port', nargs='?', type=int, default=8139)
    args = ap.parse_args()
    D = Data(args.definition, args.rom)
    print(f'open http://localhost:{args.port}  (def={args.definition})')
    print('arrange, then regenerate:  python3 tools/ff4-sfc-names.py --def ... --rom ...')
    ThreadingHTTPServer(('127.0.0.1', args.port), H).serve_forever()

if __name__ == '__main__':
    main()
