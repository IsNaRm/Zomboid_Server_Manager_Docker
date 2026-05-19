<?php

use App\Enums\BackupType;
use App\Jobs\CreateBackupJob;
use Illuminate\Support\Facades\Schedule;

Schedule::job(new CreateBackupJob(BackupType::Scheduled))
    ->everyFourHours()
    ->when(function () {
        try {
            return cache()->get('backup.schedule.hourly_enabled', true);
        } catch (\Throwable) {
            return true;
        }
    });

Schedule::command('pz:sync-accounts')->everyFiveMinutes();

Schedule::command('zomboid:sync-player-stats')->everyTenMinutes();

Schedule::command('zomboid:auto-restart-check')->everyMinute();

// Rebuild the JSON config catalog when ModManager / configure-server.sh
// drops the dirty sentinel — mod changes can shift which namespaces
// appear inside `_SandboxVars.lua`, and the admin UI hydrates from this
// catalog for descriptions / min / max / enum labels.
Schedule::command('zomboid:sync-config-catalog')
    ->everyMinute()
    ->when(fn () => is_file(rtrim(config('zomboid.paths.data', '/pz-data'), '/').'/Server/.settings_catalog_dirty')
        || is_file(rtrim(config('zomboid.paths.data', '/pz-data'), '/').'/.settings_catalog_dirty'));

Schedule::command('zomboid:import-pvp-violations')->everyFiveMinutes();

Schedule::command('zomboid:import-pvp-kills')->everyFiveMinutes();

Schedule::command('zomboid:process-respawn-kicks')->everyFiveMinutes();

Schedule::command('zomboid:parse-game-events')->everyFiveMinutes();

Schedule::command('zomboid:process-shop-deliveries')->everyMinute();

Schedule::command('zomboid:process-money-deposits')->everyMinute();

Schedule::command('zomboid:auto-render-map')->everyMinute()->runInBackground();

// Bump manifest.json version when save-game .bin files change so the browser
// poller (useAtlasVersionPoll) can invalidate its save-data cache automatically.
Schedule::command('zomboid:bump-map-version')->everyFiveMinutes();

Schedule::command('zomboid:download-item-icons')
    ->hourly()
    ->when(function () {
        $catalog = config('zomboid.lua_bridge.items_catalog');

        return file_exists($catalog) && ! glob(public_path('images/items/*.png'));
    })
    ->runInBackground();

Schedule::job(new CreateBackupJob(BackupType::Daily))
    ->dailyAt('04:00')
    ->when(function () {
        try {
            return cache()->get('backup.schedule.daily_enabled', true);
        } catch (\Throwable) {
            return true;
        }
    });
