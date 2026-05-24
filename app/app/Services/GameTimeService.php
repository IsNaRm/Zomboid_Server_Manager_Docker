<?php

namespace App\Services;

use Throwable;

class GameTimeService
{
    /**
     * Map of the PZ sandbox DayLength enum value (1-14) to its real-time
     * duration in minutes for one in-game day.
     *
     * @var array<int, int>
     */
    private const DAY_LENGTH_MINUTES = [
        1 => 15,
        2 => 30,
        3 => 60,
        4 => 120,
        5 => 180,
        6 => 240,
        7 => 300,
        8 => 360,
        9 => 420,
        10 => 480,
        11 => 540,
        12 => 600,
        13 => 660,
        14 => 720,
    ];

    private const DEFAULT_DAY_LENGTH = 2;

    public function __construct(
        private readonly SandboxLuaParser $luaParser,
    ) {}

    /**
     * Real-time minutes that one in-game day takes.
     *
     * Reads sandbox DayLength; falls back to the metadata default (30 min)
     * if the file can't be read or holds an unexpected value.
     */
    public function realMinutesPerInGameDay(): int
    {
        try {
            $sandbox = $this->luaParser->read(config('zomboid.paths.sandbox_lua'));
        } catch (Throwable) {
            $sandbox = [];
        }

        $dayLength = (int) ($sandbox['DayLength'] ?? self::DEFAULT_DAY_LENGTH);

        return self::DAY_LENGTH_MINUTES[$dayLength] ?? self::DAY_LENGTH_MINUTES[self::DEFAULT_DAY_LENGTH];
    }
}
