export type ParseModImportResult = {
    /** 'ini' when WorkshopItems=/Mods= lines were found; 'ids' when only Workshop IDs were given. */
    mode: 'ini' | 'ids';
    /** Workshop IDs, in order. In 'ids' mode this drives the per-ID Steam lookups. */
    workshopIds: string[];
    /**
     * Mod IDs from the `Mods=` line, in order. Empty in 'ids' mode until each Workshop
     * ID is resolved. PZ keeps Mods= and WorkshopItems= as independent lists (one
     * Workshop item can provide several mods), so these are NOT paired by index.
     */
    modIds: string[];
    /** Map folders parsed from a `Map=` line (includes vanilla tokens; the server skips ones already present). */
    mapFolders: string[];
};

const WORKSHOP_ID = /^\d{1,20}$/;

function readIniValue(text: string, key: string): string | null {
    const match = text.match(new RegExp(`^\\s*${key}\\s*=(.*)$`, 'im'));

    return match ? match[1].trim() : null;
}

function splitList(value: string): string[] {
    return value
        .split(';')
        .map((v) => v.trim())
        .filter((v) => v !== '');
}

function dedupe(items: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of items) {
        if (!seen.has(item)) {
            seen.add(item);
            out.push(item);
        }
    }
    return out;
}

/**
 * Parse a pasted modpack into independent Workshop / Mods / Map lists.
 *
 * Accepts either server.ini lines (`WorkshopItems=`/`Mods=`, optional `Map=`) — taken
 * verbatim, since PZ loads the two lists independently — or a bare delimited list of
 * Workshop IDs (semicolon, comma, or newline separated) which the caller then resolves
 * via the Steam lookup endpoint.
 */
export function parseModImport(text: string): ParseModImportResult {
    const workshopLine = readIniValue(text, 'WorkshopItems');
    const modsLine = readIniValue(text, 'Mods');
    const mapLine = readIniValue(text, 'Map');
    const mapFolders = mapLine !== null ? dedupe(splitList(mapLine)) : [];

    if (workshopLine !== null || modsLine !== null) {
        const workshopIds = dedupe((workshopLine !== null ? splitList(workshopLine) : []).filter((id) => WORKSHOP_ID.test(id)));
        const modIds = dedupe(modsLine !== null ? splitList(modsLine) : []);

        return { mode: 'ini', workshopIds, modIds, mapFolders };
    }

    // IDs-only: keep every distinct Workshop ID in the order it appears.
    const workshopIds = dedupe(text.split(/[;,\s]+/).map((t) => t.trim()).filter((id) => WORKSHOP_ID.test(id)));

    return { mode: 'ids', workshopIds, modIds: [], mapFolders };
}
