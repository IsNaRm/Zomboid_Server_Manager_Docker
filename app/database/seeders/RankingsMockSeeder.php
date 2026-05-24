<?php

namespace Database\Seeders;

use App\Models\GameEvent;
use App\Models\PlayerStat;
use Illuminate\Database\Seeder;

class RankingsMockSeeder extends Seeder
{
    /**
     * Populate player stats and game events so the rankings page renders
     * without a running game server.
     */
    public function run(): void
    {
        PlayerStat::query()->truncate();
        GameEvent::query()->where('event_type', 'death')->delete();
        GameEvent::query()->where('event_type', 'pvp_kill')->delete();

        $players = [
            ['username' => 'Bxio', 'zombie_kills' => 103, 'hours_survived' => 166.5, 'profession' => 'Lumberjack', 'is_dead' => false, 'deaths' => 0, 'pvp_kills' => 0],
            ['username' => 'Giorgi', 'zombie_kills' => 412, 'hours_survived' => 480.0, 'profession' => 'FireOfficer', 'is_dead' => false, 'deaths' => 3, 'pvp_kills' => 2],
            ['username' => 'NinoTheBrave', 'zombie_kills' => 285, 'hours_survived' => 320.75, 'profession' => 'Doctor', 'is_dead' => true, 'deaths' => 5, 'pvp_kills' => 0],
            ['username' => 'TornikeZ', 'zombie_kills' => 51, 'hours_survived' => 92.25, 'profession' => 'Burglar', 'is_dead' => false, 'deaths' => 1, 'pvp_kills' => 7],
            ['username' => 'DaviDestroyer', 'zombie_kills' => 678, 'hours_survived' => 700.0, 'profession' => 'Veteran', 'is_dead' => false, 'deaths' => 2, 'pvp_kills' => 12],
            ['username' => 'LasloRunner', 'zombie_kills' => 14, 'hours_survived' => 8.5, 'profession' => 'Unemployed', 'is_dead' => true, 'deaths' => 4, 'pvp_kills' => 0],
            ['username' => 'AnaWalker', 'zombie_kills' => 222, 'hours_survived' => 144.0, 'profession' => 'Chef', 'is_dead' => false, 'deaths' => 1, 'pvp_kills' => 0],
            ['username' => 'PvP_King', 'zombie_kills' => 60, 'hours_survived' => 75.0, 'profession' => 'PoliceOfficer', 'is_dead' => false, 'deaths' => 6, 'pvp_kills' => 18],
        ];

        foreach ($players as $p) {
            PlayerStat::query()->create([
                'username' => $p['username'],
                'zombie_kills' => $p['zombie_kills'],
                'hours_survived' => $p['hours_survived'],
                'profession' => $p['profession'],
                'is_dead' => $p['is_dead'],
                'skills' => [
                    'Axe' => mt_rand(0, 8),
                    'Sprinting' => mt_rand(0, 6),
                    'Carpentry' => mt_rand(0, 5),
                    'Aiming' => mt_rand(0, 7),
                ],
            ]);

            for ($i = 0; $i < $p['deaths']; $i++) {
                GameEvent::query()->create([
                    'event_type' => 'death',
                    'player' => $p['username'],
                ]);
            }

            for ($i = 0; $i < $p['pvp_kills']; $i++) {
                GameEvent::query()->create([
                    'event_type' => 'pvp_kill',
                    'player' => $p['username'],
                    'target' => $players[array_rand($players)]['username'],
                ]);
            }
        }
    }
}
