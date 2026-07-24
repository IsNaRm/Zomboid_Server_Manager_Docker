export type ParsedModEntry = { workshop_id: string; mod_id: string; map_folder?: string };

export type ParseModImportResult = {
    /** 'ini' when WorkshopItems=/Mods= lines were found and paired; 'ids' when only Workshop IDs were given. */
    mode: 'ini' | 'ids';
    /** Fully resolved pairs. Empty in 'ids' mode until each ID is looked up. */
    entries: ParsedModEntry[];
    /** Every Workshop ID found, in order (used to drive lookups in 'ids' mode). */
    workshopIds: string[];
    /** Map folders parsed from a `Map=` line (includes vanilla tokens; the server skips ones already present). */
    mapFolders: string[];
    /**
     * Workshop IDs from a `WorkshopItems=` line that had no matching entry in `Mods=`
     * (mismatched line lengths) — they can't be imported without a mod_id.
     */
    unpaired: string[];
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

/**
 * Parse a pasted modpack into structured entries.
 *
 * Accepts either server.ini lines (`WorkshopItems=`/`Mods=`, optional `Map=`), which
 * are paired by index exactly like PZ loads them, or a bare delimited list of Workshop
 * IDs (semicolon, comma, or newline separated) which the caller then resolves via the
 * Steam lookup endpoint.
 */
export function parseModImport(text: string): ParseModImportResult {
    const workshopLine = readIniValue(text, 'WorkshopItems');
    const modsLine = readIniValue(text, 'Mods');
    const mapLine = readIniValue(text, 'Map');
    const mapFolders = mapLine !== null ? splitList(mapLine) : [];

    if (workshopLine !== null || modsLine !== null) {
        const workshopIds = workshopLine !== null ? splitList(workshopLine) : [];
        const modIds = modsLine !== null ? splitList(modsLine) : [];

        const entries: ParsedModEntry[] = [];
        const unpaired: string[] = [];

        workshopIds.forEach((workshopId, i) => {
            if (!WORKSHOP_ID.test(workshopId)) {
                return;
            }
            const modId = modIds[i];
            if (modId) {
                entries.push({ workshop_id: workshopId, mod_id: modId });
            } else {
                unpaired.push(workshopId);
            }
        });

        return { mode: 'ini', entries, workshopIds: entries.map((e) => e.workshop_id), mapFolders, unpaired };
    }

    // IDs-only: keep every distinct Workshop ID in the order it appears.
    const seen = new Set<string>();
    const workshopIds: string[] = [];
    for (const token of text.split(/[;,\s]+/)) {
        const id = token.trim();
        if (WORKSHOP_ID.test(id) && !seen.has(id)) {
            seen.add(id);
            workshopIds.push(id);
        }
    }

    return { mode: 'ids', entries: [], workshopIds, mapFolders, unpaired: [] };
}
