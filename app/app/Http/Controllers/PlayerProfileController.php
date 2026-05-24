<?php

namespace App\Http\Controllers;

use App\Enums\UserRole;
use App\Models\GameEvent;
use App\Services\GameTimeService;
use App\Services\PlayerStatsService;
use Inertia\Inertia;
use Inertia\Response;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

class PlayerProfileController extends Controller
{
    public function __construct(
        private readonly PlayerStatsService $playerStatsService,
        private readonly GameTimeService $gameTime,
    ) {}

    public function __invoke(string $username): Response
    {
        $profile = $this->playerStatsService->getPlayerProfile($username);

        if (! $profile) {
            throw new NotFoundHttpException('Player not found');
        }

        $isAdmin = in_array(auth()->user()?->role, [UserRole::SuperAdmin, UserRole::Admin, UserRole::Moderator]);

        $props = [
            'player' => $profile,
            'is_admin' => $isAdmin,
            'day_length_minutes' => $this->gameTime->realMinutesPerInGameDay(),
        ];

        if ($isAdmin) {
            $props['recent_events'] = Inertia::defer(fn () => GameEvent::query()
                ->where('player', $username)
                ->orderByDesc('created_at')
                ->limit(20)
                ->get()
                ->map(fn (GameEvent $event) => [
                    'id' => $event->id,
                    'event_type' => $event->event_type,
                    'player' => $event->player,
                    'target' => $event->target,
                    'details' => $event->details,
                    'game_time' => $event->game_time?->toIso8601String(),
                    'created_at' => $event->created_at?->toIso8601String(),
                ])
                ->all());
        }

        return Inertia::render('player-profile', $props);
    }
}
