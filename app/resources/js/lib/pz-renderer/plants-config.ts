/**
 * Plants configuration — TypeScript port of pzmap2dzi/plants.py.
 *
 * Provides season-aware sprite name remapping for vegetation tiles.
 * Handles bush, grass, small trees, and jumbo trees with the same
 * logic as the Python reference renderer.
 *
 * Usage:
 *   const plants = new PlantsInfo({});                 // summer2 defaults
 *   const resolved = plants.resolve('vegetation_trees_01_3');
 *   // => ['e_redmapleJUMBO_1_2']  (depending on conf)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Season = 'spring' | 'summer' | 'summer2' | 'autumn' | 'winter';

/**
 * Plants rendering configuration. Mirrors pzmap2dzi conf.yaml / PlantsInfo ctor.
 */
export interface PlantsConfig {
    /** Season determines foliage variant. Default: 'summer2'. */
    season?: Season;
    /** Snow overlay replaces seasonal variants. Default: false. */
    snow?: boolean;
    /** Show flower overlay on bushes/grass. Default: false. */
    flower?: boolean;
    /** Use large bush variant instead of small. Default: false. */
    large_bush?: boolean;
    /** Small tree size index [0-3], 0 = smallest. Default: 2. */
    tree_size?: number;
    /** Jumbo tree size index [0-5]. Must be >= tree_size. Default: 3. */
    jumbo_tree_size?: number;
    /** Which tree species to use for jumbo trees [1-11]. Default: 1. */
    jumbo_tree_type?: number;
    /** Hide grass/groundcover (no_ground_cover in Python). Default: false. */
    no_ground_cover?: boolean;
    /** Force all trees to use one species [0=none, 1-11=species]. Default: 0. */
    unify_tree_type?: number;
}

// ---------------------------------------------------------------------------
// Tree species table  (mirrors _TREE_DEF in plants.py)
// Index 0 = index 1 in Python (jumbo_type is 1-based)
// ---------------------------------------------------------------------------

interface TreeDef {
    name: string;
    tilesetNumber: number;
    isEvergreen: boolean;
    windType: number;
}

const TREE_DEF: readonly TreeDef[] = [
    { name: 'americanholly',      tilesetNumber:  1, isEvergreen: true,  windType: 3 },
    { name: 'americanlinden',     tilesetNumber:  2, isEvergreen: false, windType: 2 },
    { name: 'canadianhemlock',    tilesetNumber:  3, isEvergreen: true,  windType: 3 },
    { name: 'carolinasilverbell', tilesetNumber:  4, isEvergreen: false, windType: 1 },
    { name: 'cockspurhawthorn',   tilesetNumber:  5, isEvergreen: false, windType: 2 },
    { name: 'dogwood',            tilesetNumber:  6, isEvergreen: false, windType: 2 },
    { name: 'easternredbud',      tilesetNumber:  7, isEvergreen: false, windType: 2 },
    { name: 'redmaple',           tilesetNumber:  8, isEvergreen: false, windType: 2 },
    { name: 'riverbirch',         tilesetNumber:  9, isEvergreen: false, windType: 1 },
    { name: 'virginiapine',       tilesetNumber: 10, isEvergreen: true,  windType: 1 },
    { name: 'yellowwood',         tilesetNumber: 11, isEvergreen: false, windType: 2 },
] as const;

// ---------------------------------------------------------------------------
// Internal: get_tree()  — mirrors plants.py:get_tree()
// ---------------------------------------------------------------------------

/**
 * Compute the list of sprite names to composite for a single tree square.
 *
 * @param treeName   Lowercase tree species name (from TREE_DEF.name).
 * @param season     Current season.
 * @param snow       Snow overlay active?
 * @param size       Size index [0-5]. ≥4 = jumbo.
 * @param evergreen  Whether this species is evergreen.
 * @returns          1–2 sprite names to alpha-composite, bottom-to-top.
 */
function getTree(
    treeName: string,
    season: Season,
    snow: boolean,
    size: number,
    evergreen: boolean,
): string[] {
    const isJumbo = size >= 4;
    const idx = size % 4;
    const prefix = isJumbo ? `e_${treeName}JUMBO_1_` : `e_${treeName}_1_`;
    const step = isJumbo ? 2 : 4;

    if (snow) {
        return [`${prefix}${idx + step}`];
    }

    const textures: string[] = [`${prefix}${idx}`];

    if (!evergreen) {
        if (season === 'spring') {
            textures.push(`${prefix}${idx + step * 2}`);
        }
        if (season === 'summer') {
            textures.push(`${prefix}${idx + step * 3}`);
        }
        if (season === 'summer2') {
            textures.push(`${prefix}${idx + step * 4}`);
        }
        if (season === 'autumn') {
            textures.push(`${prefix}${idx + step * 5}`);
        }
    }

    return textures;
}

// ---------------------------------------------------------------------------
// PlantsInfo  — mirrors plants.py:PlantsInfo
// ---------------------------------------------------------------------------

/**
 * Pre-computed sprite remapping table for a given plants configuration.
 *
 * Construct once (cheap), then call resolve() per-tile at render time (O(1)).
 */
export class PlantsInfo {
    /**
     * Internal map: original sprite name → replacement sprite name list.
     * Empty array means "draw nothing" (no_ground_cover, winter grass, etc.).
     */
    private readonly mapping: Map<string, string[]>;

    constructor(conf: PlantsConfig = {}) {
        const season: Season = conf.season ?? 'summer2';
        const snow     = conf.snow          ?? false;
        const flower   = conf.flower        ?? false;
        const largeBush = conf.large_bush   ?? false;
        const treeSize  = Math.max(0, Math.min(3, Math.round(conf.tree_size ?? 2)));
        const jumboSize = Math.max(treeSize, Math.min(5, Math.round(conf.jumbo_tree_size ?? 3)));
        const jumboType = Math.min(11, Math.max(1, Math.round(conf.jumbo_tree_type ?? 1)));
        const noGrass   = conf.no_ground_cover ?? false;
        const unifyTree = Math.min(11, Math.max(0, Math.round(conf.unify_tree_type ?? 0)));

        this.mapping = new Map();

        // ---------------------------------------------------------------
        // Bushes (vegetation_foliage_01_0..15)
        // ---------------------------------------------------------------
        const bush: string[][] = [];
        for (let i = 0; i < 16; i++) {
            const trunk = i % 8;
            const offset1 = largeBush ? 8 : 0;
            const offset2 = largeBush ? 32 : 0;
            const textures: string[] = [];

            if (snow) {
                textures.push(`f_bushes_1_${trunk + offset1 + 16}`);
            } else {
                textures.push(`f_bushes_1_${trunk + offset1}`);
                if (season === 'spring')                { textures.push(`f_bushes_1_${trunk + offset1 + 32}`); }
                if (season === 'summer' || season === 'summer2') { textures.push(`f_bushes_1_${i + offset2 + 64}`); }
                if (season === 'autumn')                { textures.push(`f_bushes_1_${trunk + offset1 + 48}`); }
                if (flower)                             { textures.push(`f_bushes_1_${i + offset2 + 80}`); }
            }
            bush.push(textures);
        }

        for (let i = 0; i < 16; i++) {
            this.mapping.set(`vegetation_foliage_01_${i}`, noGrass ? [] : bush[i]!);
        }

        // ---------------------------------------------------------------
        // Grass (vegetation_groundcover_01_0..47)
        // ---------------------------------------------------------------
        const grass: string[][] = [];
        for (let i = 0; i < 24; i++) {
            const offset = Math.floor(i / 8) * 16 + 16;
            const imod8  = i % 8;
            const textures: string[] = [];

            if (season === 'spring')                { textures.push(`d_plants_1_${imod8}`); }
            if (season === 'summer' || season === 'summer2') { textures.push(`d_plants_1_${offset + imod8}`); }
            if (season === 'autumn')                { textures.push(`d_plants_1_${8 + imod8}`); }
            if (flower)                             { textures.push(`d_plants_1_${offset + 8 + imod8}`); }

            grass.push(textures);
        }

        for (let i = 0; i < 48; i++) {
            this.mapping.set(`vegetation_groundcover_01_${i}`, noGrass ? [] : grass[i % 24]!);
        }

        // ---------------------------------------------------------------
        // Small trees (vegetation_trees_01_0..32)
        // ---------------------------------------------------------------
        const treeSprites: string[][] = TREE_DEF.map(({ name, isEvergreen }) =>
            getTree(name, season, snow, treeSize, isEvergreen),
        );

        for (let i = 0; i < 33; i++) {
            let textures = treeSprites[i % TREE_DEF.length]!;
            if (unifyTree > 0) {
                textures = treeSprites[unifyTree - 1]!;
            }
            this.mapping.set(`vegetation_trees_01_${i}`, textures);
        }

        // ---------------------------------------------------------------
        // Jumbo tree
        // ---------------------------------------------------------------
        const effectiveJumboType = unifyTree > 0 ? unifyTree : jumboType;
        const jumboDef = TREE_DEF[effectiveJumboType - 1]!;
        const jumboTextures = getTree(jumboDef.name, season, snow, jumboSize, jumboDef.isEvergreen);
        this.mapping.set('jumbo_tree_01_0', jumboTextures);
    }

    /**
     * Resolve a sprite name to its seasonal replacement(s).
     *
     * @param name   Tile name from lotpack (e.g. 'vegetation_trees_01_3').
     * @returns      Array of 0-N replacement sprite names to composite, or
     *               null when this name has no remapping rule (pass-through).
     */
    resolve(name: string): string[] | null {
        const mapped = this.mapping.get(name);
        return mapped !== undefined ? mapped : null;
    }

    /**
     * Check whether a sprite name is covered by any remapping rule.
     */
    hasMappingFor(name: string): boolean {
        return this.mapping.has(name);
    }

    /**
     * Iterate all remapping entries. Useful for debugging.
     */
    entries(): IterableIterator<[string, string[]]> {
        return this.mapping.entries();
    }
}

// ---------------------------------------------------------------------------
// Convenience function  (mirrors plants.py usage in texture.py config_plants)
// ---------------------------------------------------------------------------

/**
 * Apply plants remapping to a single sprite name.
 *
 * Returns:
 *  - original name in an array if no remapping rule applies (pass-through)
 *  - empty array if the sprite should not be rendered (no_ground_cover etc.)
 *  - replacement name(s) array when a remapping rule matches
 *
 * @param name        Original sprite name from lotpack.
 * @param plantsInfo  Pre-built PlantsInfo instance.
 */
export function remapSpriteName(name: string, plantsInfo: PlantsInfo): string[] {
    const resolved = plantsInfo.resolve(name);
    if (resolved === null) {
        // No remapping rule → pass original through
        return [name];
    }
    return resolved;
}

// ---------------------------------------------------------------------------
// Default config (matches pzmap2dzi conf.yaml defaults)
// ---------------------------------------------------------------------------

/** Default plants configuration identical to pzmap2dzi defaults. */
export const DEFAULT_PLANTS_CONFIG: Required<PlantsConfig> = {
    season:          'summer2',
    snow:            false,
    flower:          false,
    large_bush:      false,
    tree_size:       2,
    jumbo_tree_size: 3,
    jumbo_tree_type: 1,
    no_ground_cover: false,
    unify_tree_type: 0,
} as const;

/** Singleton PlantsInfo built from the default config. Reuse across renders. */
export const defaultPlantsInfo = new PlantsInfo(DEFAULT_PLANTS_CONFIG);
