<?php

namespace App\Services;

class ModManager
{
    /**
     * Mods that must remain installed for the manager to work, keyed by
     * Workshop ID with the corresponding `mod_id` as the value. The
     * proprietary ZomboidManager mod provides the Lua bridge used by
     * inventory, delivery, and player-position features — removing it
     * breaks core functionality, so the API/UI refuse to remove these
     * and write paths re-attach them automatically if they go missing.
     */
    public const PROTECTED_MODS = [
        '3685323705' => 'ZomboidManager',
    ];

    /**
     * @var list<string>
     */
    public const PROTECTED_WORKSHOP_IDS = ['3685323705'];

    public function __construct(
        private readonly ServerIniParser $iniParser,
    ) {}

    public static function isProtected(string $workshopId): bool
    {
        return array_key_exists($workshopId, self::PROTECTED_MODS);
    }

    /**
     * Get the current mod list.
     *
     * Prefers `.mod_state` (the user's intended list, written by add/remove/reorder)
     * over the live INI, because PZ rewrites the INI on shutdown/startup and may
     * leave stale or empty Mods= entries between container restarts. Falls back to
     * the INI when the state file is missing or malformed.
     *
     * @return array<int, array{workshop_id: string, mod_id: string, position: int}>
     */
    public function list(string $iniPath): array
    {
        $current = $this->readCurrentLists($iniPath);
        $modIds = $current['mod_ids'];
        $workshopIds = $current['workshop_ids'];
        $map = $current['map'];

        $mods = [];
        foreach ($modIds as $position => $modId) {
            // Prefer the explicit map. Fall back to positional pairing for
            // legacy `.mod_state` files that predate the WorkshopMap line.
            $workshopId = $map[$modId] ?? ($workshopIds[$position] ?? '');
            $mods[] = [
                'workshop_id' => $workshopId,
                'mod_id' => $modId,
                'position' => $position,
            ];
        }

        return $mods;
    }

    /**
     * Get the mod list with per-mod load status.
     *
     * Compares `.mod_state` (user intent) against `.mod_state_applied` (the
     * snapshot configure-server.sh wrote when PZ last started) to decide whether
     * each mod is actively running, awaiting a restart, or whether the server is
     * stopped.
     *
     * Statuses:
     *  - 'stopped'         — game server is not running; load state unknown
     *  - 'pending_restart' — mod is in user intent but not in the running config
     *  - 'active'          — mod is in user intent and was applied at last start
     *
     * When `.mod_state_applied` is missing (legacy containers from before this
     * file was written), every mod returned by `list()` is treated as 'active' if
     * the server is running — we can't know what changed since startup without
     * the snapshot.
     *
     * @return array{
     *     mods: array<int, array{workshop_id: string, mod_id: string, position: int, status: string}>,
     *     pending_restart: bool,
     *     server_running: bool,
     *     applied_snapshot_present: bool,
     * }
     */
    public function listWithStatus(string $iniPath, bool $serverRunning): array
    {
        $mods = $this->list($iniPath);
        $applied = $this->parseStateFile(dirname($iniPath).'/.mod_state_applied');
        $appliedModIds = $applied !== null
            ? $this->splitList($applied['Mods'])
            : null;

        $pendingRestart = false;

        foreach ($mods as $i => $mod) {
            if (! $serverRunning) {
                $status = 'stopped';
            } elseif ($appliedModIds === null) {
                $status = 'active';
            } elseif (in_array($mod['mod_id'], $appliedModIds, true)) {
                $status = 'active';
            } else {
                $status = 'pending_restart';
                $pendingRestart = true;
            }

            $mods[$i]['status'] = $status;
        }

        if ($serverRunning && $applied !== null) {
            $intentModIds = array_column($mods, 'mod_id');
            $removedSinceStart = array_diff($appliedModIds, $intentModIds);
            if (! empty($removedSinceStart)) {
                $pendingRestart = true;
            }
        }

        return [
            'mods' => $mods,
            'pending_restart' => $pendingRestart,
            'server_running' => $serverRunning,
            'applied_snapshot_present' => $applied !== null,
        ];
    }

    /**
     * Parse `.mod_state` into its Mods / WorkshopItems / WorkshopMap values.
     *
     * Returns null when the file is absent, unreadable, or missing either of
     * the two mandatory lines. The optional WorkshopMap line is consumed when
     * present (modpack support); when absent, callers fall back to positional
     * pairing of Mods and WorkshopItems for backwards compatibility.
     *
     * @return array{Mods: string, WorkshopItems: string, WorkshopMap: string}|null
     */
    private function parseStateFile(string $stateFile): ?array
    {
        if (! is_readable($stateFile)) {
            return null;
        }

        $contents = @file_get_contents($stateFile);

        if ($contents === false) {
            return null;
        }

        if (! preg_match('/^Mods=(.*)$/m', $contents, $modsMatch)
            || ! preg_match('/^WorkshopItems=(.*)$/m', $contents, $workshopMatch)) {
            return null;
        }

        $mapMatch = [];
        preg_match('/^WorkshopMap=(.*)$/m', $contents, $mapMatch);

        return [
            'Mods' => trim($modsMatch[1]),
            'WorkshopItems' => trim($workshopMatch[1]),
            'WorkshopMap' => isset($mapMatch[1]) ? trim($mapMatch[1]) : '',
        ];
    }

    /**
     * Add one or more mod IDs that all belong to the same Workshop item.
     *
     * Accepts either a single `mod_id` string (legacy) or a `mod_ids` list to
     * support Workshop "modpacks" — one Workshop ID that ships multiple mods.
     * Each `mod_id` is appended to `Mods=` individually; `WorkshopItems=`
     * stays deduplicated and the `mod_id => workshop_id` mapping is updated
     * for every new pair.
     *
     * @param  list<string>|string  $modIds
     */
    public function add(string $iniPath, string $workshopId, array|string $modIds, ?string $mapFolder = null): void
    {
        $modIdsList = is_array($modIds) ? array_values($modIds) : [$modIds];
        $modIdsList = array_values(array_filter($modIdsList, fn ($id) => is_string($id) && $id !== ''));

        if ($modIdsList === []) {
            return;
        }

        $current = $this->readCurrentLists($iniPath);
        $workshopIdsOut = $current['workshop_ids'];
        $modIdsOut = $current['mod_ids'];
        $mapOut = $current['map'];

        $changed = false;
        foreach ($modIdsList as $modId) {
            if (in_array($modId, $modIdsOut, true)) {
                continue;
            }
            $modIdsOut[] = $modId;
            $mapOut[$modId] = $workshopId;
            $changed = true;
        }

        if (! in_array($workshopId, $workshopIdsOut, true)) {
            $workshopIdsOut[] = $workshopId;
            $changed = true;
        }

        if (! $changed) {
            return;
        }

        $updates = [
            'WorkshopItems' => implode(';', $workshopIdsOut),
            'Mods' => implode(';', $modIdsOut),
        ];

        if ($mapFolder !== null) {
            $config = $this->iniParser->read($iniPath);
            $maps = $this->splitList($config['Map'] ?? 'Muldraugh, KY', ';');
            if (! in_array($mapFolder, $maps, true)) {
                $maps[] = $mapFolder;
                $updates['Map'] = implode(';', $maps);
            }
        }

        $this->writeIniAndState($iniPath, $updates, $mapOut);
    }

    /**
     * Remove a single `(workshop_id, mod_id)` pair, or — when `$modId` is null —
     * every mod that belongs to the given Workshop ID (legacy removal).
     *
     * The Workshop ID is dropped from `WorkshopItems=` only once *no* remaining
     * mod_id in the map still points at it. This keeps shared modpack Workshop
     * IDs intact when only some of their mods are removed.
     *
     * @return array{workshop_id: string, mod_id: string}|null The removed mod (the
     *                                                          last one if multiple), or null if not found.
     */
    public function remove(string $iniPath, string $workshopId, ?string $modId = null, ?string $mapFolder = null): ?array
    {
        $current = $this->readCurrentLists($iniPath);
        $workshopIdsOut = $current['workshop_ids'];
        $modIdsOut = $current['mod_ids'];
        $mapOut = $current['map'];

        $targets = [];
        if ($modId !== null) {
            // Targeted removal: only the requested (workshop_id, mod_id) pair.
            $owningWorkshop = $mapOut[$modId] ?? null;
            if ($owningWorkshop === $workshopId && in_array($modId, $modIdsOut, true)) {
                $targets[] = $modId;
            } elseif ($owningWorkshop === null && in_array($modId, $modIdsOut, true)) {
                // Legacy state without map — accept if positional pairing matches.
                $position = array_search($modId, $modIdsOut, true);
                if ($position !== false && ($workshopIdsOut[$position] ?? null) === $workshopId) {
                    $targets[] = $modId;
                }
            }
        } else {
            // Legacy removal: every mod_id tied to this workshop_id (including
            // through positional pairing for pre-WorkshopMap state files).
            foreach ($modIdsOut as $position => $candidate) {
                $owningWorkshop = $mapOut[$candidate] ?? ($workshopIdsOut[$position] ?? null);
                if ($owningWorkshop === $workshopId) {
                    $targets[] = $candidate;
                }
            }
        }

        if ($targets === []) {
            return null;
        }

        $lastRemoved = end($targets);
        foreach ($targets as $target) {
            $position = array_search($target, $modIdsOut, true);
            if ($position !== false) {
                array_splice($modIdsOut, $position, 1);
            }
            unset($mapOut[$target]);
        }

        // Drop the workshop_id only when no remaining mod_id still maps to it.
        $stillReferenced = in_array($workshopId, $mapOut, true);
        if (! $stillReferenced) {
            $workshopIdsOut = array_values(array_filter(
                $workshopIdsOut,
                fn ($id) => $id !== $workshopId,
            ));
        }

        $updates = [
            'WorkshopItems' => implode(';', $workshopIdsOut),
            'Mods' => implode(';', $modIdsOut),
        ];

        if ($mapFolder !== null) {
            $config = $this->iniParser->read($iniPath);
            $maps = $this->splitList($config['Map'] ?? '', ';');
            $maps = array_filter($maps, fn ($m) => $m !== $mapFolder);
            $updates['Map'] = implode(';', array_values($maps));
        }

        $this->writeIniAndState($iniPath, $updates, $mapOut);

        return [
            'workshop_id' => $workshopId,
            'mod_id' => (string) $lastRemoved,
        ];
    }

    /**
     * Reorder mods by replacing both lines with the given ordered list.
     *
     * @param  array<int, array{workshop_id: string, mod_id: string}>  $orderedMods
     */
    public function reorder(string $iniPath, array $orderedMods): void
    {
        $current = $this->readCurrentLists($iniPath);

        foreach (array_keys(self::PROTECTED_MODS) as $required) {
            // Cast: PHP coerces numeric-string array keys to int; compare as strings.
            $requiredStr = (string) $required;
            $stillPresent = false;
            foreach ($orderedMods as $entry) {
                if (($entry['workshop_id'] ?? null) === $requiredStr) {
                    $stillPresent = true;
                    break;
                }
            }
            if (in_array($requiredStr, $current['workshop_ids'], true) && ! $stillPresent) {
                throw \Illuminate\Validation\ValidationException::withMessages([
                    'mods' => ["Reorder cannot drop required mod {$requiredStr}."],
                ]);
            }
        }

        $workshopIdsOut = [];
        $modIdsOut = [];
        $mapOut = [];
        foreach ($orderedMods as $entry) {
            $workshopId = (string) ($entry['workshop_id'] ?? '');
            $modId = (string) ($entry['mod_id'] ?? '');
            if ($modId === '') {
                continue;
            }
            $modIdsOut[] = $modId;
            $mapOut[$modId] = $workshopId;
            if ($workshopId !== '' && ! in_array($workshopId, $workshopIdsOut, true)) {
                $workshopIdsOut[] = $workshopId;
            }
        }

        $this->writeIniAndState(
            $iniPath,
            [
                'WorkshopItems' => implode(';', $workshopIdsOut),
                'Mods' => implode(';', $modIdsOut),
            ],
            $mapOut,
        );
    }

    /**
     * Read the current Workshop/Mods/Map view used by `add`, `remove`, and `reorder`.
     *
     * Prefers `.mod_state` (the web-UI's source of truth) over the live INI,
     * because PZ rewrites the INI on shutdown and may prune entries it didn't
     * load. Without this preference, an `add()` call performed while the INI
     * was pruned would silently drop every previously-installed mod.
     *
     * For legacy `.mod_state` files without a `WorkshopMap=` line, the returned
     * map is reconstructed from positional pairing of Mods and WorkshopItems
     * so callers can rely on it unconditionally.
     *
     * @return array{
     *     workshop_ids: list<string>,
     *     mod_ids: list<string>,
     *     map: array<string, string>,
     * }
     */
    private function readCurrentLists(string $iniPath): array
    {
        $state = $this->parseStateFile(dirname($iniPath).'/.mod_state');

        if ($state !== null) {
            $workshopIds = $this->splitList($state['WorkshopItems']);
            $modIds = $this->splitList($state['Mods']);
            $map = $this->parseWorkshopMap($state['WorkshopMap']);
            if ($map === []) {
                $map = $this->derivePositionalMap($modIds, $workshopIds);
            }

            return [
                'workshop_ids' => $workshopIds,
                'mod_ids' => $modIds,
                'map' => $map,
            ];
        }

        $config = $this->iniParser->read($iniPath);
        $workshopIds = $this->splitList($config['WorkshopItems'] ?? '');
        $modIds = $this->splitList($config['Mods'] ?? '');

        return [
            'workshop_ids' => $workshopIds,
            'mod_ids' => $modIds,
            'map' => $this->derivePositionalMap($modIds, $workshopIds),
        ];
    }

    /**
     * Parse a `ModA:X;ModB:X;ModC:Y` mapping string.
     *
     * @return array<string, string>
     */
    private function parseWorkshopMap(string $value): array
    {
        $map = [];
        foreach ($this->splitList($value) as $pair) {
            $sep = strpos($pair, ':');
            if ($sep === false) {
                continue;
            }
            $modId = trim(substr($pair, 0, $sep));
            $workshopId = trim(substr($pair, $sep + 1));
            if ($modId !== '' && $workshopId !== '') {
                $map[$modId] = $workshopId;
            }
        }

        return $map;
    }

    /**
     * Best-effort positional mapping for legacy state files that pre-date
     * the WorkshopMap line.
     *
     * @param  list<string>  $modIds
     * @param  list<string>  $workshopIds
     * @return array<string, string>
     */
    private function derivePositionalMap(array $modIds, array $workshopIds): array
    {
        $map = [];
        foreach ($modIds as $position => $modId) {
            if (isset($workshopIds[$position])) {
                $map[$modId] = $workshopIds[$position];
            }
        }

        return $map;
    }

    /**
     * Re-attach any protected mods that are absent from the given lists.
     * Mutates all three structures in-place. The protected mod is appended
     * at the end so the user's ordering of optional mods is preserved.
     *
     * @param  list<string>  $workshopIds
     * @param  list<string>  $modIds
     * @param  array<string, string>  $map
     */
    private function ensureProtectedMods(array &$workshopIds, array &$modIds, array &$map): void
    {
        foreach (self::PROTECTED_MODS as $workshopId => $modId) {
            // PHP coerces numeric string array keys to int, so cast back before
            // comparing against the string Workshop IDs we get from splitList.
            // Without the cast, in_array with strict=true treats int 3685323705
            // and "3685323705" as different and appends a duplicate every write.
            $workshopIdStr = (string) $workshopId;
            if (in_array($modId, $modIds, true)) {
                $map[$modId] = $workshopIdStr;

                continue;
            }
            $modIds[] = $modId;
            $map[$modId] = $workshopIdStr;
            if (! in_array($workshopIdStr, $workshopIds, true)) {
                $workshopIds[] = $workshopIdStr;
            }
        }
    }

    /**
     * Serialise the workshop map back into `ModA:X;ModB:X;ModC:Y` form.
     *
     * @param  array<string, string>  $map
     */
    private function serializeWorkshopMap(array $map): string
    {
        $pairs = [];
        foreach ($map as $modId => $workshopId) {
            $pairs[] = (string) $modId.':'.(string) $workshopId;
        }

        return implode(';', $pairs);
    }

    /**
     * Apply INI updates and write the mod state snapshot atomically. If the
     * state-file write fails, the prior INI content is restored so callers see
     * an all-or-nothing outcome rather than a partially-applied change.
     *
     * @param  array<string, string>  $updates
     * @param  array<string, string>  $map
     */
    private function writeIniAndState(string $iniPath, array $updates, array $map): void
    {
        if (isset($updates['WorkshopItems']) && isset($updates['Mods'])) {
            $workshopIds = $this->splitList($updates['WorkshopItems']);
            $modIds = $this->splitList($updates['Mods']);
            $this->ensureProtectedMods($workshopIds, $modIds, $map);
            $updates['WorkshopItems'] = implode(';', $workshopIds);
            $updates['Mods'] = implode(';', $modIds);
        }

        $previousIni = @file_get_contents($iniPath);

        $this->iniParser->write($iniPath, $updates);

        try {
            $this->writeModState($iniPath, $map);
        } catch (\Throwable $e) {
            if ($previousIni !== false) {
                @file_put_contents($iniPath, $previousIni);
            }
            throw $e;
        }

        // Signal the scheduled config-catalog rebuild: mod changes can shift
        // which mod-namespaces appear inside `_SandboxVars.lua`, so the JSON
        // catalog the admin UI hydrates from goes stale on every write here.
        @touch(dirname($iniPath).'/.settings_catalog_dirty');
    }

    /**
     * Write a mod state snapshot to the shared volume.
     *
     * This file is read by configure-server.sh on container restart
     * to restore web-UI mod changes that would otherwise be overwritten
     * by the game server image's own configuration logic.
     *
     * @param  array<string, string>  $map
     */
    private function writeModState(string $iniPath, array $map): void
    {
        $config = $this->iniParser->read($iniPath);

        $mods = str_replace(["\n", "\r"], '', $config['Mods'] ?? '');
        $workshopItems = str_replace(["\n", "\r"], '', $config['WorkshopItems'] ?? '');

        // Filter the map to only include mod_ids that survive in Mods=.
        $surviving = $this->splitList($mods);
        $filteredMap = [];
        foreach ($surviving as $modId) {
            if (isset($map[$modId])) {
                $filteredMap[$modId] = $map[$modId];
            }
        }

        $stateFile = dirname($iniPath).'/.mod_state';
        $stateDir = dirname($stateFile);
        $contents = "Mods=$mods\nWorkshopItems=$workshopItems\nWorkshopMap=".$this->serializeWorkshopMap($filteredMap)."\n";
        $tempFile = @tempnam($stateDir, '.mod_state.');

        if ($tempFile === false || dirname($tempFile) !== $stateDir) {
            if ($tempFile !== false) {
                @unlink($tempFile);
            }
            throw new \RuntimeException("Unable to create temporary mod state file in {$stateDir}.");
        }

        try {
            if (@file_put_contents($tempFile, $contents) === false) {
                throw new \RuntimeException("Unable to write temporary mod state file {$tempFile}.");
            }

            if (! @rename($tempFile, $stateFile)) {
                throw new \RuntimeException("Unable to atomically replace mod state file {$stateFile}.");
            }

            @chmod($stateFile, 0644);
        } finally {
            if (is_file($tempFile)) {
                @unlink($tempFile);
            }
        }
    }

    /**
     * @return string[]
     */
    private function splitList(string $value, string $separator = ';'): array
    {
        if ($value === '') {
            return [];
        }

        return array_values(array_filter(
            array_map('trim', explode($separator, $value)),
            fn ($v) => $v !== '',
        ));
    }
}
