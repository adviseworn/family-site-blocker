# Describes a file's Finder info and resource fork: layout, resources, and the icns entries inside.
import struct, subprocess, sys
for path in sys.argv[1:]:
    info = subprocess.run(['xattr', '-px', 'com.apple.FinderInfo', path], capture_output=True, text=True).stdout.replace(' ', '').replace('\n', '')
    fork = open(path + '/..namedfork/rsrc', 'rb').read()
    out = [f'{path}: FinderInfo {info or "none"}; fork {len(fork)} bytes']
    if len(fork) >= 16:
        data_at, map_at, data_len, map_len = struct.unpack('>IIII', fork[:16])
        rmap = fork[map_at:map_at + map_len]
        types_at, names_at = struct.unpack('>HH', rmap[24:28])
        out.append(f'data@{data_at}+{data_len} map@{map_at}+{map_len} types@{types_at} names@{names_at} '
                   f'fork-attrs {struct.unpack(">H", rmap[22:24])[0]:#x} header-copy {rmap[:16] == fork[:16]} '
                   f'reserved-bytes-nonzero {sum(1 for b in fork[16:256] if b)}')
        for t in range(struct.unpack('>H', rmap[types_at:types_at + 2])[0] + 1):
            kind, n, ref_at = struct.unpack('>4sHH', rmap[types_at + 2 + 8 * t:types_at + 10 + 8 * t])
            for r in range(n + 1):
                rid, name_at, attrs_offset, _ = struct.unpack('>hHII', rmap[types_at + ref_at + 12 * r:types_at + ref_at + 12 * r + 12])
                at = data_at + (attrs_offset & 0xFFFFFF)
                size = struct.unpack('>I', fork[at:at + 4])[0]
                res = fork[at + 4:at + 4 + size]
                parts = []
                if kind == b'icns':
                    i = 8
                    while i < len(res):
                        k, length = struct.unpack('>4sI', res[i:i + 8])
                        parts.append(f'{k.decode("latin1")}:{length}')
                        i += length
                out.append(f'{kind.decode("latin1")} id {rid} name {name_at:#x} attrs {attrs_offset >> 24:#x} size {size} [{" ".join(parts)}]')
    print(' | '.join(out))
