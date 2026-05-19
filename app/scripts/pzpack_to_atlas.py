#!/usr/bin/env python3
"""
Pack PZ texturepacks into a mip-mapped WebP sprite atlas for browser WebGL rendering.

Outputs a multi-page atlas plus a sprites.json index that the frontend WebGL
renderer uses to look up sprite UV coordinates at any mip level.

Usage:
    python3 pzpack_to_atlas.py --input /pz-data/texturepacks --output /map-tiles/web
    python3 pzpack_to_atlas.py --input ./packs --output ./web --atlas-size 4096 --max-mip 10
"""

import argparse
import hashlib
import io
import json
import os
import sys
import time
from pathlib import Path

# Bind into the pzmap2dzi tree shipped with the container so we can re-use the
# existing .pack parser without re-implementing a fragile binary reader.
sys.path.insert(0, '/opt/pzmap2dzi')
from pzmap2dzi.texture import load_pack  # noqa: E402

from PIL import Image  # noqa: E402

try:
    import rectpack
except ImportError:
    print('rectpack not installed — run: pip install rectpack', file=sys.stderr)
    sys.exit(1)


DEFAULT_INCLUDE_PACKS = [
    'Tiles2x.pack',
    'Tiles2x.floor.pack',
    'JumboTrees2x.pack',
    'Overlays2x.pack',
]


def collect_sprites(packs_dir: Path, include_patterns: list[str] | None = None):
    """Yield every sprite (name, RGBA image, offsets) found in any .pack file.

    include_patterns: list of substrings; only .pack files whose name contains
    any of these substrings are scanned. None = default vanilla map set.
    Pass an empty list ([]) to process every .pack in the directory.
    """
    pack_files = sorted(packs_dir.glob('*.pack'))
    if not pack_files:
        raise SystemExit(f'No .pack files found in {packs_dir}')

    if include_patterns is None:
        include_patterns = DEFAULT_INCLUDE_PACKS

    if include_patterns:
        pack_files = [p for p in pack_files if any(pat in p.name for pat in include_patterns)]
        if not pack_files:
            raise SystemExit(f'No .pack files matched filters: {include_patterns}')
        print(f'Filtered to {len(pack_files)} packs matching: {", ".join(include_patterns)}')

    seen = {}
    for pack_file in pack_files:
        print(f'  · {pack_file.name}', flush=True)
        pages = load_pack(str(pack_file))
        for page_idx, page in enumerate(pages):
            page_im = Image.open(io.BytesIO(page['png'])).convert('RGBA')
            for tex in page['textures']:
                name = tex['name']
                x, y, w, h = tex['x'], tex['y'], tex['w'], tex['h']
                ox, oy, ow, oh = tex['ox'], tex['oy'], tex['ow'], tex['oh']
                if w <= 0 or h <= 0:
                    continue
                sprite_im = page_im.crop((x, y, x + w, y + h))
                # PZ convention: offset relative to bottom-center of the square
                shifted_ox = ox - (ow >> 1)
                shifted_oy = oy - oh
                key = (name, w, h)
                if key in seen:
                    # Mod packs are loaded after vanilla; mod overrides win.
                    continue
                seen[key] = True
                yield {
                    'name': name,
                    'image': sprite_im,
                    'offset_x': shifted_ox,
                    'offset_y': shifted_oy,
                    'pack': pack_file.name,
                }


def reserve_mip_space(width: int, height: int, max_mip: int) -> tuple[int, int]:
    """How wide/tall does a sprite need to be in the atlas to carry mip levels.

    To pack mips alongside the base sprite we widen the slot by 50% (1 + 1/2)
    horizontally to host the half-size mip, then quarter-size, etc. This is the
    classic "right-of and below-of" mip layout that fits geometrically inside
    a 1.5x box.
    """
    levels = min(max_mip, max(width, height).bit_length() - 1)
    # Reserved size = w + w/2 (mip-1) and h + h/2 — gives clean power-of-two slots
    return width + (width >> 1) + 2, max(height, height + (height >> 1) + 2), levels


def pack_atlases(sprites: list, atlas_size: int, max_mip: int):
    """Bin-pack sprites into atlas pages with mip reservation.

    Returns list of (rectpack.Rect, sprite_dict, mip_levels).
    """
    packer = rectpack.newPacker(
        mode=rectpack.PackingMode.Offline,
        bin_algo=rectpack.PackingBin.BFF,
        rotation=False,
    )
    # Sort by area (largest first) — improves bin-packing density significantly.
    sprites_sorted = sorted(
        sprites,
        key=lambda s: s['image'].size[0] * s['image'].size[1],
        reverse=True,
    )

    for sprite in sprites_sorted:
        w, h = sprite['image'].size
        reserved_w, reserved_h, _ = reserve_mip_space(w, h, max_mip)
        if reserved_w > atlas_size or reserved_h > atlas_size:
            print(f'  ! sprite {sprite["name"]} too big ({reserved_w}x{reserved_h}), skipped', file=sys.stderr)
            continue
        packer.add_rect(reserved_w, reserved_h, sprite)
    # 64 bin upper limit — vanilla map needs ~10, mod packs ~30; never seen above 64.
    packer.add_bin(atlas_size, atlas_size, count=64)
    packer.pack()

    placements = []
    for bin_idx, abin in enumerate(packer):
        for rect in abin:
            placements.append((bin_idx, rect, rect.rid))
    return placements


def generate_mipmaps(image: Image.Image, max_mip: int) -> list[Image.Image]:
    """Build a chain [base, half, quarter, ...] down to 1x1 (or max_mip)."""
    chain = [image]
    cur = image
    for _ in range(max_mip):
        w, h = cur.size
        if w <= 1 and h <= 1:
            break
        nw = max(1, w // 2)
        nh = max(1, h // 2)
        cur = cur.resize((nw, nh), Image.LANCZOS)
        chain.append(cur)
    return chain


def render_atlas(placements_in_bin: list, atlas_size: int, max_mip: int):
    """Composite all sprites + their mipmap chains onto one atlas page."""
    atlas = Image.new('RGBA', (atlas_size, atlas_size), (0, 0, 0, 0))
    sprite_records = []

    for rect, sprite_dict in placements_in_bin:
        x, y = rect.x, rect.y
        base = sprite_dict['image']
        atlas.paste(base, (x, y))

        chain = generate_mipmaps(base, max_mip)
        # Place mip 1+ to the right of base
        mip_y = y
        mip_x = x + base.width
        mip_offsets = [(x, y, base.width, base.height)]
        for level, mip_im in enumerate(chain[1:], start=1):
            atlas.paste(mip_im, (mip_x, mip_y))
            mip_offsets.append((mip_x, mip_y, mip_im.width, mip_im.height))
            mip_y += mip_im.height

        sprite_records.append({
            'name': sprite_dict['name'],
            'mips': mip_offsets,                    # [(u, v, w, h), ...]
            'offset_x': sprite_dict['offset_x'],
            'offset_y': sprite_dict['offset_y'],
            'pack': sprite_dict['pack'],
        })

    return atlas, sprite_records


def build_atlas(input_dir: Path, output_dir: Path, atlas_size: int, max_mip: int,
                version: str, include_packs: list[str] | None = None):
    output_dir.mkdir(parents=True, exist_ok=True)

    print('Step 1/4: Collecting sprites from .pack files')
    sprites = list(collect_sprites(input_dir, include_patterns=include_packs))
    print(f'  → {len(sprites)} unique sprites')

    print('Step 2/4: Bin-packing into atlas pages')
    placements = pack_atlases(sprites, atlas_size, max_mip)
    by_bin: dict[int, list] = {}
    for bin_idx, rect, sprite_dict in placements:
        by_bin.setdefault(bin_idx, []).append((rect, sprite_dict))
    print(f'  → {len(by_bin)} atlas page(s) needed')

    print('Step 3/4: Rendering atlas pages + generating mipmaps')
    atlases_meta = []
    all_sprite_records = {}
    for bin_idx in sorted(by_bin):
        print(f'  · page {bin_idx}: {len(by_bin[bin_idx])} sprites')
        atlas_im, records = render_atlas(by_bin[bin_idx], atlas_size, max_mip)
        out_path = output_dir / f'atlas-{version}-{bin_idx}.webp'
        atlas_im.save(out_path, 'WEBP', lossless=True, quality=100, method=4)
        size_bytes = out_path.stat().st_size
        atlases_meta.append({
            'id': bin_idx,
            'file': out_path.name,
            'width': atlas_size,
            'height': atlas_size,
            'size_bytes': size_bytes,
        })
        for r in records:
            all_sprite_records[r['name']] = {
                'atlas': bin_idx,
                'mips': r['mips'],
                'offset_x': r['offset_x'],
                'offset_y': r['offset_y'],
            }

    print('Step 4/4: Writing sprites.json + manifest.json')
    sprites_index_path = output_dir / 'sprites.json'
    with sprites_index_path.open('w') as fh:
        json.dump({
            'version': version,
            'atlas_size': atlas_size,
            'atlases': atlases_meta,
            'sprites': all_sprite_records,
        }, fh, separators=(',', ':'))

    total_size = sum(a['size_bytes'] for a in atlases_meta) + sprites_index_path.stat().st_size
    checksum = hashlib.sha256()
    for a in atlases_meta:
        with (output_dir / a['file']).open('rb') as fh:
            checksum.update(fh.read())

    manifest_path = output_dir / 'manifest.json'
    with manifest_path.open('w') as fh:
        json.dump({
            'version': version,
            'built_at': int(time.time()),
            'atlas_count': len(atlases_meta),
            'sprite_count': len(all_sprite_records),
            'total_bytes': total_size,
            'checksum': checksum.hexdigest(),
        }, fh, indent=2)

    return {
        'version': version,
        'atlas_count': len(atlases_meta),
        'sprite_count': len(all_sprite_records),
        'total_bytes': total_size,
    }


def parse_args():
    p = argparse.ArgumentParser(description='Build mip-mapped sprite atlas from PZ texturepacks')
    p.add_argument('--input', type=Path, default='/pz-data/texturepacks',
                   help='Directory containing .pack files')
    p.add_argument('--output', type=Path, default='/map-tiles/web',
                   help='Output directory for atlas and sprites.json')
    p.add_argument('--atlas-size', type=int, default=4096,
                   help='Edge size of each atlas page in pixels')
    p.add_argument('--max-mip', type=int, default=10,
                   help='Maximum mip level depth (down to 1x1 by default)')
    p.add_argument('--version', type=str, default=None,
                   help='Atlas version string (default: timestamp)')
    p.add_argument('--include-pack', action='append', dest='include_packs', default=None,
                   help='Substring of .pack filenames to include (repeatable). '
                        'Default: vanilla map packs only. Pass --include-pack "" once '
                        'to include every pack found.')
    return p.parse_args()


def main():
    args = parse_args()
    if not args.input.is_dir():
        raise SystemExit(f'Input directory does not exist: {args.input}')

    version = args.version or f'v{int(time.time())}'
    started_at = time.time()
    print(f'Building atlas version "{version}"')
    print(f'  input:       {args.input}')
    print(f'  output:      {args.output}')
    print(f'  atlas size:  {args.atlas_size}px')
    print(f'  max mip:     {args.max_mip}')
    print('')

    include_packs = args.include_packs
    if include_packs is not None:
        # If the user passed --include-pack "" we treat it as "no filter".
        include_packs = [p for p in include_packs if p] or []

    summary = build_atlas(args.input, args.output, args.atlas_size, args.max_mip,
                          version, include_packs=include_packs)
    duration = time.time() - started_at
    print('')
    print(f'Atlas built in {duration:.1f}s')
    print(f'  atlases:   {summary["atlas_count"]}')
    print(f'  sprites:   {summary["sprite_count"]}')
    print(f'  total:     {summary["total_bytes"] / (1024 * 1024):.1f} MB')


if __name__ == '__main__':
    main()
