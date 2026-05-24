<?php

namespace App\Http\Controllers;

use App\Services\GameTimeService;
use App\Services\PlayerStatsService;
use Inertia\Inertia;
use Inertia\Response;

class RankingsController extends Controller
{
    public function __construct(
        private readonly PlayerStatsService $playerStatsService,
        private readonly GameTimeService $gameTime,
    ) {}

    public function __invoke(): Response
    {
        return Inertia::render('rankings', [
            'server_stats' => $this->playerStatsService->getServerStats(),
            'day_length_minutes' => $this->gameTime->realMinutesPerInGameDay(),
            'leaderboard_kills' => Inertia::defer(fn () => $this->playerStatsService->getFullLeaderboard('zombie_kills', 25)),
            'leaderboard_survival' => Inertia::defer(fn () => $this->playerStatsService->getFullLeaderboard('hours_survived', 25)),
            'leaderboard_deaths' => Inertia::defer(fn () => $this->playerStatsService->getDeathLeaderboard(25)),
            'leaderboard_kd' => Inertia::defer(fn () => $this->playerStatsService->getRatioLeaderboard('kills_per_death', 25)),
            'leaderboard_hd' => Inertia::defer(fn () => $this->playerStatsService->getRatioLeaderboard('hours_per_death', 25)),
            'leaderboard_pvpd' => Inertia::defer(fn () => $this->playerStatsService->getRatioLeaderboard('pvp_per_death', 25)),
            'leaderboard_spent' => Inertia::defer(fn () => $this->playerStatsService->getWalletLeaderboard('total_spent', 25)),
            'leaderboard_balance' => Inertia::defer(fn () => $this->playerStatsService->getWalletLeaderboard('balance', 25)),
            'server_name' => config('zomboid.server_name', 'Project Zomboid Server'),
        ]);
    }
}
