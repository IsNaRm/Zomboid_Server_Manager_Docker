/**
 * Atlas manifest version polling for the WebGL PZ map renderer.
 *
 * Polls `/pz-atlas/manifest.json` at a configurable interval (default 30 s).
 * When the `version` field changes the hook returns the new version string and
 * fires the optional `onVersionChange` callback so callers can invalidate the
 * cell cache / save-game cache.
 *
 * Design notes:
 *   - Uses the native fetch API — no dependencies.
 *   - A slow network or offline server does not crash the poller; errors are
 *     silently swallowed and the last known version is kept.
 *   - The interval is reset on each successful response, not on each tick, so
 *     a slow server won't pile up concurrent requests.
 *   - The hook returns `lastRefreshedAt` (Date | null) so UI can display
 *     "last checked X seconds ago".
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AtlasVersionPollState {
    /** Current atlas version string. Null until the first successful fetch. */
    version: string | null;
    /** Timestamp of the last successful manifest fetch. */
    lastRefreshedAt: Date | null;
    /** True when the very first poll is in-flight. */
    initialising: boolean;
}

interface ManifestJson {
    version?: string;
    [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * React hook that polls the atlas manifest every `interval` ms and returns
 * the current version string plus a refresh timestamp.
 *
 * @param manifestUrl   Full URL to manifest.json. Defaults to `/pz-atlas/manifest.json`.
 * @param interval      Polling interval in milliseconds. Defaults to 30 000 (30 s).
 * @param onVersionChange  Optional callback fired when the version string changes.
 *                         Receives the new version and the previous version.
 */
export function useAtlasVersionPoll(
    manifestUrl: string = '/pz-atlas/manifest.json',
    interval: number = 30_000,
    onVersionChange?: (newVersion: string, prevVersion: string | null) => void,
): AtlasVersionPollState {
    const [state, setState] = useState<AtlasVersionPollState>({
        version: null,
        lastRefreshedAt: null,
        initialising: true,
    });

    // Keep stable ref to callback so changing the prop doesn't restart polling
    const callbackRef = useRef(onVersionChange);
    useEffect(() => {
        callbackRef.current = onVersionChange;
    }, [onVersionChange]);

    // Keep current version in a ref so the interval closure always reads fresh
    const versionRef = useRef<string | null>(null);

    const poll = useCallback(async () => {
        try {
            const res = await fetch(manifestUrl, {
                // Bypass browser cache so we always get fresh data
                cache: 'no-store',
            });

            if (!res.ok) {
                return;
            }

            const json: ManifestJson = await res.json() as ManifestJson;
            const newVersion = typeof json.version === 'string' ? json.version : null;

            if (newVersion === null) {
                return;
            }

            const prevVersion = versionRef.current;

            if (newVersion !== prevVersion) {
                versionRef.current = newVersion;
                callbackRef.current?.(newVersion, prevVersion);
            }

            setState({
                version: newVersion,
                lastRefreshedAt: new Date(),
                initialising: false,
            });
        } catch {
            // Network error or JSON parse failure — keep last known state
            setState((prev) => ({ ...prev, initialising: false }));
        }
    }, [manifestUrl]);

    useEffect(() => {
        // Immediate first poll
        void poll();

        const timer = setInterval(() => {
            void poll();
        }, interval);

        return () => {
            clearInterval(timer);
        };
    }, [poll, interval]);

    return state;
}
