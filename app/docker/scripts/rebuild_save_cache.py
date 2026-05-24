#!/usr/bin/env python3
"""
Парсит все PZ save .bin chunks в save-каталоге, агрегирует по cell-координатам
и пишет packed Uint32Array файлы для WebGL рендера на клиенте.

Output per cell:
    cell-{cellX}_{cellY}.packed  — массив u32 entries:
        bits 0-15:  sprite_id (global, из sprites.json порядка ключей)
        bits 16-23: sx (cell-local, 0..255)
        bits 24-31: sy (cell-local, 0..255)
    cell-{cellX}_{cellY}.strides — Uint32Array(7) strideOffsets (compat с base map renderer)

Manifest:
    manifest.json — версия + cells + mtimes

Coordinate math (B42):
    cell = 32 × 32 chunks = 256 × 256 squares
    chunkX → cellX = chunkX // 32
    inside chunk: local x, y in [0..7] (block_size=8)
    cell-local sx = (chunkX % 32) * 8 + x
"""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import os
import re
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, '/opt/pzmap2dzi')

NEW_BLOCK_NAME = re.compile(r'^(\d+)\.bin$')
OLD_BLOCK_NAME = re.compile(r'^map_(\d+)_(\d+)\.bin$')

BLOCK_SIZE_B41 = 10
BLOCK_SIZE_B42 = 8
CELL_SIZE_IN_BLOCKS_B41 = 30
CELL_SIZE_IN_BLOCKS_B42 = 32
KEEP_LAYER_MIN = 0
KEEP_LAYER_MAX = 1


def scan_chunks(save_dir: str) -> tuple[list[tuple[int, int, str]], int]:
    """Возвращает [(chunkX, chunkY, path), ...] и save_version (41 или 42)."""
    chunks: list[tuple[int, int, str]] = []
    map_dir = os.path.join(save_dir, 'map')
    save_version = 42

    if os.path.isdir(map_dir):
        for x_entry in os.listdir(map_dir):
            x_path = os.path.join(map_dir, x_entry)
            if not os.path.isdir(x_path) or not x_entry.isdigit():
                continue
            cx = int(x_entry)
            for y_entry in os.listdir(x_path):
                m = NEW_BLOCK_NAME.match(y_entry)
                if not m:
                    continue
                cy = int(m.group(1))
                chunks.append((cx, cy, os.path.join(x_path, y_entry)))
    else:
        save_version = 41
        for entry in os.listdir(save_dir):
            m = OLD_BLOCK_NAME.match(entry)
            if not m:
                continue
            chunks.append((int(m.group(1)), int(m.group(2)),
                           os.path.join(save_dir, entry)))

    return chunks, save_version


def detect_save_version(first_chunk_path: str) -> int:
    with open(first_chunk_path, 'rb') as f:
        data = f.read(5)
    if len(data) < 5:
        return 42
    world_version = struct.unpack('>I', data[1:5])[0]
    return 41 if world_version <= 195 else 42


def load_sprite_name_to_id(sprites_json_path: str) -> dict[str, int]:
    with open(sprites_json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    mapping: dict[str, int] = {}
    for idx, name in enumerate(data.get('sprites', {}).keys()):
        mapping[name] = idx
    return mapping


_worker_state: dict = {}


def _worker_init(pz_root: str, mod_root: str | None, save_version: int,
                 world_dict_path: str | None, lib_path: str,
                 sprite_name_to_id: dict[str, int]) -> None:
    """Инициализация форкнутого воркера (lazy-load pzdataspec)."""
    sys.path.insert(0, lib_path)
    sys.path.insert(0, '/opt/pzmap2dzi')
    from pzmap2dzi.plants import jumbo_tree_defs
    from pzdataspec import utils
    _worker_state['utils'] = utils
    _worker_state['save_version'] = save_version
    _worker_state['block_size'] = BLOCK_SIZE_B41 if save_version == 41 else BLOCK_SIZE_B42

    tile_defs = utils.load_tile_defs(pz_root, mod_root, save_version)
    jumbo_file_number = 5 if save_version == 41 else 6
    tile_defs.update(jumbo_tree_defs(jumbo_file_number))
    if world_dict_path and os.path.exists(world_dict_path):
        wd_sprites = utils.load_world_dict_sprites(world_dict_path, save_version)
        tile_defs.update(wd_sprites)
    _worker_state['tile_defs'] = tile_defs
    _worker_state['sprite_name_to_id'] = sprite_name_to_id


def _parse_chunk(args: tuple[int, int, str]) -> tuple[int, int, list[tuple[int, int, int]]]:
    """Парсит один chunk → список (cell_local_sx, cell_local_sy, sprite_id)."""
    chunk_x, chunk_y, path = args
    utils = _worker_state['utils']
    block_size = _worker_state['block_size']
    tile_defs = _worker_state['tile_defs']
    sprite_name_to_id = _worker_state['sprite_name_to_id']
    save_version = _worker_state['save_version']

    block = utils.load_chunk(path, save_version)
    if block is None:
        return chunk_x, chunk_y, []

    cell_size_in_blocks = CELL_SIZE_IN_BLOCKS_B41 if save_version == 41 else CELL_SIZE_IN_BLOCKS_B42
    # chunk_x % cell_size_in_blocks даёт chunk-offset внутри cell.
    chunk_in_cell_x = chunk_x % cell_size_in_blocks
    chunk_in_cell_y = chunk_y % cell_size_in_blocks
    base_sx = chunk_in_cell_x * block_size
    base_sy = chunk_in_cell_y * block_size

    entries: list[tuple[int, int, int]] = []
    min_layer = max(block.min_layer, KEEP_LAYER_MIN)
    max_layer = min(block.max_layer, KEEP_LAYER_MAX - 1)
    for layer in range(min_layer, max_layer + 1):
        for x in range(block_size):
            sx = (base_sx + x) & 0xff
            for y in range(block_size):
                sy = (base_sy + y) & 0xff
                sprites = block.get_sprites(layer, x, y)
                if not sprites:
                    continue
                for sprite_id in sprites:
                    name = tile_defs.get(sprite_id)
                    if name is None:
                        continue
                    global_id = sprite_name_to_id.get(name)
                    if global_id is None or global_id > 0xffff:
                        continue
                    entries.append((sx, sy, global_id))

    return chunk_x, chunk_y, entries


def write_cell_packed(output_dir: str, cell_x: int, cell_y: int,
                      entries: list[tuple[int, int, int]]) -> int:
    """Пишет packed Uint32Array + strideOffsets для одной cell. Возвращает bytes written."""
    if not entries:
        return 0
    buf = bytearray(4 * len(entries))
    for i, (sx, sy, sprite_id) in enumerate(entries):
        packed = (sprite_id & 0xffff) | ((sx & 0xff) << 16) | ((sy & 0xff) << 24)
        struct.pack_into('<I', buf, i * 4, packed)
    out_path = os.path.join(output_dir, f'cell-{cell_x}_{cell_y}.packed')
    with open(out_path, 'wb') as f:
        f.write(buf)

    # strideOffsets[K] = count of entries with strideLevel >= K.
    # Save-overlay rendering не использует super-cell — фиксируем total на всех K.
    total = len(entries)
    strides = struct.pack('<7I', total, total, total, total, total, total, total)
    with open(os.path.join(output_dir, f'cell-{cell_x}_{cell_y}.strides'), 'wb') as f:
        f.write(strides)
    return len(buf) + 28


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--save-dir', required=True,
                        help='/pz-data/Saves/Multiplayer/{server}')
    parser.add_argument('--pz-root', required=True, help='/pz-server')
    parser.add_argument('--mod-root', default=None, help='Workshop mods root')
    parser.add_argument('--output-dir', required=True,
                        help='/map-tiles/save-cache')
    parser.add_argument('--sprites-json', required=True,
                        help='/map-tiles/web/sprites.json')
    parser.add_argument('--lib-path', default='/map-tiles/lib',
                        help='Где живёт pzdataspec')
    parser.add_argument('--workers', type=int,
                        default=max(1, (os.cpu_count() or 4) - 1))
    parser.add_argument('--server-name', default='Server')
    parser.add_argument('--verbose', action='store_true')
    parser.add_argument('--since-mtime', type=int, default=0,
                        help='Incremental mode: re-parse только cells содержащие '
                             'chunks с mtime > since-mtime. 0 = full rebuild.')
    args = parser.parse_args()

    if not os.path.isdir(args.save_dir):
        print(f'[rebuild] save-dir missing: {args.save_dir}', file=sys.stderr)
        return 2

    t_start = time.time()
    chunks, _ = scan_chunks(args.save_dir)
    if not chunks:
        print('[rebuild] no save chunks found, nothing to do')
        os.makedirs(args.output_dir, exist_ok=True)
        manifest = {
            'version': 'empty',
            'world': args.server_name,
            'cells': [],
            'generated_at': int(time.time()),
        }
        with open(os.path.join(args.output_dir, 'manifest.json'), 'w', encoding='utf-8') as f:
            json.dump(manifest, f)
        return 0

    save_version = detect_save_version(chunks[0][2])
    block_size = BLOCK_SIZE_B41 if save_version == 41 else BLOCK_SIZE_B42
    cell_size_in_blocks = CELL_SIZE_IN_BLOCKS_B41 if save_version == 41 else CELL_SIZE_IN_BLOCKS_B42
    print(f'[rebuild] chunks={len(chunks)} save_version=B{save_version} '
          f'block_size={block_size} cells_per_axis_per_cell={cell_size_in_blocks}')

    sprite_name_to_id = load_sprite_name_to_id(args.sprites_json)
    print(f'[rebuild] sprite atlas vocabulary: {len(sprite_name_to_id)} names')

    world_dict_path = os.path.join(args.save_dir, 'WorldDictionary.bin')

    os.makedirs(args.output_dir, exist_ok=True)

    # Incremental mode: определить какие cells затронуты chunks с mtime > since.
    # Внутри затронутых cells re-parse'им ВСЕ chunks (нельзя partial — entries
    # хранятся за cell как сплошной список, у нас нет per-chunk granularity
    # на диске).
    cells_to_rebuild: set[tuple[int, int]] | None = None
    if args.since_mtime > 0:
        cells_to_rebuild = set()
        for cx, cy, path in chunks:
            try:
                if os.path.getmtime(path) > args.since_mtime:
                    cells_to_rebuild.add(
                        (cx // cell_size_in_blocks, cy // cell_size_in_blocks))
            except OSError:
                continue
        if not cells_to_rebuild:
            print('[rebuild] incremental: 0 cells to update, skipping work')
            return 0
        print(f'[rebuild] incremental: {len(cells_to_rebuild)} cells need rebuild')
        # Фильтруем chunks к подмножеству этих cells.
        chunks = [
            c for c in chunks
            if (c[0] // cell_size_in_blocks, c[1] // cell_size_in_blocks) in cells_to_rebuild
        ]
        print(f'[rebuild] incremental: chunks reduced to {len(chunks)}')

    # Multiprocess parsing
    init_args = (args.pz_root, args.mod_root, save_version, world_dict_path,
                 args.lib_path, sprite_name_to_id)
    cell_entries: dict[tuple[int, int], list[tuple[int, int, int]]] = {}
    cell_mtimes: dict[tuple[int, int], int] = {}

    parse_start = time.time()
    if args.workers <= 1:
        _worker_init(*init_args)
        for chunk_args in chunks:
            cx, cy, entries = _parse_chunk(chunk_args)
            cell_key = (cx // cell_size_in_blocks, cy // cell_size_in_blocks)
            if entries:
                cell_entries.setdefault(cell_key, []).extend(entries)
            mtime = int(os.path.getmtime(chunk_args[2]))
            if mtime > cell_mtimes.get(cell_key, 0):
                cell_mtimes[cell_key] = mtime
    else:
        with mp.Pool(args.workers, initializer=_worker_init,
                     initargs=init_args) as pool:
            for cx, cy, entries in pool.imap_unordered(_parse_chunk, chunks, chunksize=64):
                cell_key = (cx // cell_size_in_blocks, cy // cell_size_in_blocks)
                if entries:
                    cell_entries.setdefault(cell_key, []).extend(entries)
            for cx, cy, path in chunks:
                cell_key = (cx // cell_size_in_blocks, cy // cell_size_in_blocks)
                try:
                    mtime = int(os.path.getmtime(path))
                except OSError:
                    continue
                if mtime > cell_mtimes.get(cell_key, 0):
                    cell_mtimes[cell_key] = mtime

    parse_secs = time.time() - parse_start
    print(f'[rebuild] parse done in {parse_secs:.2f}s — {len(cell_entries)} non-empty cells')

    # Write per-cell packed files
    write_start = time.time()
    total_bytes = 0
    total_entries = 0
    for (cell_x, cell_y), entries in cell_entries.items():
        total_entries += len(entries)
        total_bytes += write_cell_packed(args.output_dir, cell_x, cell_y, entries)
    write_secs = time.time() - write_start
    print(f'[rebuild] wrote {len(cell_entries)} cells / {total_entries} entries / '
          f'{total_bytes/1024/1024:.2f} MB in {write_secs:.2f}s')

    # Clean stale .packed files (cells which used to have data but now empty).
    # В incremental mode не трогаем cells вне cells_to_rebuild — они валидны
    # с предыдущего полного прогона.
    existing_files = {f for f in os.listdir(args.output_dir)
                      if f.startswith('cell-') and (f.endswith('.packed') or f.endswith('.strides'))}
    expected_files: set[str] = set()
    for (cell_x, cell_y) in cell_entries.keys():
        expected_files.add(f'cell-{cell_x}_{cell_y}.packed')
        expected_files.add(f'cell-{cell_x}_{cell_y}.strides')
    if cells_to_rebuild is None:
        for stale in existing_files - expected_files:
            try:
                os.remove(os.path.join(args.output_dir, stale))
            except OSError:
                pass
    else:
        # Только удаляем .packed для cells которые мы перебрали но они оказались empty.
        for (cell_x, cell_y) in cells_to_rebuild:
            if (cell_x, cell_y) not in cell_entries:
                for ext in ('.packed', '.strides'):
                    stale = f'cell-{cell_x}_{cell_y}{ext}'
                    if stale in existing_files:
                        try:
                            os.remove(os.path.join(args.output_dir, stale))
                        except OSError:
                            pass

    # Manifest — в incremental mode объединяем с предыдущим
    if cells_to_rebuild is not None:
        prev_manifest_path = os.path.join(args.output_dir, 'manifest.json')
        if os.path.isfile(prev_manifest_path):
            try:
                with open(prev_manifest_path, 'r', encoding='utf-8') as f:
                    prev = json.load(f)
                for cell in prev.get('cells', []):
                    pcx, pcy, pmtime = cell[0], cell[1], cell[2]
                    if (pcx, pcy) in cells_to_rebuild:
                        continue
                    if (pcx, pcy) not in cell_mtimes:
                        cell_mtimes[(pcx, pcy)] = pmtime
                        cell_entries.setdefault((pcx, pcy), [])  # marker that cell exists
            except (json.JSONDecodeError, OSError):
                pass
    all_cells = set(cell_mtimes.keys())
    cells_list = sorted([(cx, cy, cell_mtimes[(cx, cy)])
                         for (cx, cy) in all_cells])
    max_mtime = max((m for _, _, m in cells_list), default=0)
    version_str = f'{args.server_name}|{max_mtime}|{len(cells_list)}'
    import hashlib
    version_hash = hashlib.sha1(version_str.encode()).hexdigest()

    manifest = {
        'version': version_hash,
        'world': args.server_name,
        'save_version': save_version,
        'cells': cells_list,
        'generated_at': int(time.time()),
    }
    with open(os.path.join(args.output_dir, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f)

    total_secs = time.time() - t_start
    print(f'[rebuild] DONE in {total_secs:.2f}s: '
          f'{len(chunks)} chunks → {len(cells_list)} cells, '
          f'avg {parse_secs * 1000 / max(1, len(chunks)):.2f}ms/chunk '
          f'({args.workers} workers)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
