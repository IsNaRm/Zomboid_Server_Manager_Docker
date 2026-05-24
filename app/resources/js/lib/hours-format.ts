export type HoursMode = 'ingame' | 'real';

const STORAGE_KEY = 'zm:hours-mode';

export function loadHoursMode(): HoursMode {
    if (typeof window === 'undefined') {
        return 'ingame';
    }
    return window.localStorage.getItem(STORAGE_KEY) === 'real' ? 'real' : 'ingame';
}

export function saveHoursMode(mode: HoursMode): void {
    if (typeof window === 'undefined') {
        return;
    }
    window.localStorage.setItem(STORAGE_KEY, mode);
}

/**
 * Convert in-game hours (PZ's getHoursSurvived) into the chosen display unit.
 * One in-game day is 24 in-game hours and spans dayLengthMinutes of real time.
 */
export function convertHours(inGameHours: number, mode: HoursMode, dayLengthMinutes: number): number {
    if (mode === 'ingame') {
        return inGameHours;
    }
    return (inGameHours * dayLengthMinutes) / (24 * 60);
}

export function formatHours(inGameHours: number, mode: HoursMode, dayLengthMinutes: number): string {
    const value = convertHours(inGameHours, mode, dayLengthMinutes);
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}h`;
}
