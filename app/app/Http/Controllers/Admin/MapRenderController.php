<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\UpdateMapRenderQualityRequest;
use App\Http\Requests\Admin\UpdateMapRenderScheduleRequest;
use App\Http\Requests\Admin\UploadTexturepacksRequest;
use App\Models\MapRenderSetting;
use App\Services\AuditLogger;
use App\Services\MapRenderService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use ZipArchive;

class MapRenderController extends Controller
{
    public function __construct(
        private readonly MapRenderService $renderer,
        private readonly AuditLogger $auditLogger,
    ) {}

    public function enableEngine(Request $request): JsonResponse
    {
        if (! $this->renderer->isEngineInstalled()) {
            return response()->json([
                'message' => 'Render engine binary (pzmap2dzi) is not installed in this container.',
            ], 503);
        }

        $setting = MapRenderSetting::instance();
        $setting->engine_enabled = true;
        $setting->save();

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'map.render.engine_enabled',
            ip: $request->ip(),
        );

        return response()->json(['message' => 'Render engine enabled']);
    }

    public function disableEngine(Request $request): JsonResponse
    {
        $setting = MapRenderSetting::instance();
        $setting->engine_enabled = false;
        $setting->save();

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'map.render.engine_disabled',
            ip: $request->ip(),
        );

        return response()->json(['message' => 'Render engine disabled']);
    }

    public function startRender(Request $request): JsonResponse
    {
        if (! $this->renderer->isEngineEnabled()) {
            return response()->json(['message' => 'Render engine is disabled.'], 422);
        }

        if (! $this->renderer->isEngineInstalled()) {
            return response()->json(['message' => 'pzmap2dzi binary is missing from the container.'], 503);
        }

        if ($this->renderer->isRendering()) {
            return response()->json(['message' => 'A render is already in progress.'], 409);
        }

        $this->renderer->dispatchRender($request->user()->name ?? 'admin', $request->ip());

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'map.render.started',
            ip: $request->ip(),
        );

        return response()->json(['message' => 'Render queued']);
    }

    public function pauseRender(Request $request): JsonResponse
    {
        if (! $this->renderer->isRendering()) {
            return response()->json(['message' => 'No render is currently running.'], 422);
        }

        if ($this->renderer->isPaused()) {
            return response()->json(['message' => 'Render is already paused.'], 422);
        }

        if (! $this->renderer->pauseRender()) {
            return response()->json(['message' => 'Failed to pause the queue container via Docker API.'], 500);
        }

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'map.render.paused',
            ip: $request->ip(),
        );

        return response()->json(['message' => 'Render paused']);
    }

    public function resumeRender(Request $request): JsonResponse
    {
        if (! $this->renderer->isPaused()) {
            return response()->json(['message' => 'Render is not paused.'], 422);
        }

        if (! $this->renderer->resumeRender()) {
            return response()->json(['message' => 'Failed to resume the queue container via Docker API.'], 500);
        }

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'map.render.resumed',
            ip: $request->ip(),
        );

        return response()->json(['message' => 'Render resumed']);
    }

    public function cancelRender(Request $request): JsonResponse
    {
        if (! $this->renderer->isRendering()) {
            return response()->json(['message' => 'No render is currently running.'], 422);
        }

        $this->renderer->requestCancel();
        $killed = $this->renderer->killRenderProcesses();

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'map.render.cancel_requested',
            details: ['kill_dispatched' => $killed],
            ip: $request->ip(),
        );

        return response()->json([
            'message' => $killed
                ? 'Cancel issued — pzmap2dzi processes were killed inside the queue container.'
                : 'Cancel flagged, but kill via Docker exec failed (check logs). The job will stop at the next stage boundary instead.',
            'kill_dispatched' => $killed,
        ]);
    }

    public function uploadTexturepacks(UploadTexturepacksRequest $request): JsonResponse
    {
        if ($this->renderer->isRendering()) {
            return response()->json(['message' => 'A render is in progress — cannot replace texturepacks now.'], 409);
        }

        $file = $request->file('archive');
        $destination = $this->renderer->texturepacksPath();

        if (! is_dir($destination)) {
            if (! @mkdir($destination, 0755, true) && ! is_dir($destination)) {
                return response()->json(['message' => "Cannot create texturepacks directory at {$destination}"], 500);
            }
        }

        $zip = new ZipArchive;
        $opened = $zip->open($file->getRealPath());

        if ($opened !== true) {
            return response()->json(['message' => 'Could not open the uploaded zip archive.'], 422);
        }

        $required = ['Tiles2x.floor.pack', 'JumboTrees2x.pack', 'Overlays2x.pack', 'Tiles2x.pack'];
        $extracted = [];

        for ($i = 0; $i < $zip->numFiles; $i++) {
            $stat = $zip->statIndex($i);
            $entryName = $stat['name'] ?? '';

            if ($entryName === '' || str_ends_with($entryName, '/')) {
                continue;
            }

            $basename = basename($entryName);

            if (str_contains($basename, '..') || str_contains($entryName, "\0")) {
                continue;
            }

            if (! str_ends_with(strtolower($basename), '.pack')) {
                continue;
            }

            $stream = $zip->getStream($entryName);

            if ($stream === false) {
                continue;
            }

            $target = $destination.'/'.$basename;
            $out = @fopen($target, 'wb');

            if ($out === false) {
                fclose($stream);
                continue;
            }

            stream_copy_to_stream($stream, $out);
            fclose($out);
            fclose($stream);

            $extracted[] = $basename;
        }

        $zip->close();

        $missing = array_values(array_diff($required, $extracted));

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'map.render.texturepacks_uploaded',
            details: ['extracted' => count($extracted), 'missing_required' => $missing],
            ip: $request->ip(),
        );

        if ($missing !== []) {
            return response()->json([
                'message' => 'Archive uploaded but required pack files are missing: '.implode(', ', $missing),
                'extracted' => $extracted,
                'missing_required' => $missing,
            ], 422);
        }

        return response()->json([
            'message' => 'Texturepacks uploaded',
            'extracted' => $extracted,
        ]);
    }

    /**
     * Сохраняет custom URL для скачивания atlas tarball в MapRenderSetting.
     * Пустая строка / null сбрасывает override → используется env/config.
     */
    public function updateAtlasUrl(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'atlas_download_url' => ['nullable', 'string', 'max:500', 'url:http,https'],
        ]);

        $setting = MapRenderSetting::instance();
        $setting->atlas_download_url = $validated['atlas_download_url'] ?? null;
        $setting->save();

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'map.atlas.url_updated',
            details: ['atlas_download_url' => $setting->atlas_download_url],
            ip: $request->ip(),
        );

        return response()->json([
            'message' => 'Atlas download URL updated',
            'effective_url' => $setting->effectiveAtlasDownloadUrl(),
        ]);
    }

    /**
     * Запускает фоновое скачивание atlas tarball через artisan-команду.
     * Сам HTTP-запрос возвращается сразу, скачивание идёт в `nohup`.
     */
    public function downloadAtlas(Request $request): JsonResponse
    {
        $force = (bool) $request->boolean('force');
        $setting = MapRenderSetting::instance();
        $url = $setting->effectiveAtlasDownloadUrl();

        if ($url === null) {
            return response()->json([
                'message' => 'Atlas download URL не задан. Установите его в настройках или через PZ_MAP_ATLAS_DOWNLOAD_URL env.',
            ], 422);
        }

        // Запускаем команду в фоне, ответ не блокируется на 700 MB скачивании.
        $cmd = sprintf(
            '(php %s zomboid:download-atlas %s > %s 2>&1 &)',
            escapeshellarg(base_path('artisan')),
            $force ? '--force' : '',
            escapeshellarg(storage_path('logs/atlas-download.log')),
        );
        @shell_exec($cmd);

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'map.atlas.download_started',
            details: ['url' => $url, 'force' => $force],
            ip: $request->ip(),
        );

        return response()->json([
            'message' => 'Atlas download started in background. Watch storage/logs/atlas-download.log',
            'url' => $url,
        ]);
    }

    public function deleteTexturepacks(Request $request): JsonResponse
    {
        if ($this->renderer->isRendering()) {
            return response()->json(['message' => 'A render is in progress — cannot remove texturepacks now.'], 409);
        }

        $path = $this->renderer->texturepacksPath();

        if (is_dir($path)) {
            foreach ((array) glob($path.'/*.pack') as $file) {
                if (is_string($file) && is_file($file)) {
                    @unlink($file);
                }
            }
        }

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'map.render.texturepacks_deleted',
            ip: $request->ip(),
        );

        return response()->json(['message' => 'Texturepacks removed']);
    }

    public function updateQuality(UpdateMapRenderQualityRequest $request): JsonResponse
    {
        if ($this->renderer->isRendering()) {
            return response()->json(['message' => 'A render is in progress — cannot change quality settings now.'], 409);
        }

        $validated = $request->validated();
        $setting = MapRenderSetting::instance();

        $setting->quality_preset = $validated['quality_preset'];
        $setting->custom_tile_size = $validated['quality_preset'] === 'custom'
            ? ($validated['custom_tile_size'] ?? null)
            : null;
        $setting->custom_omit_levels = $validated['quality_preset'] === 'custom'
            ? ($validated['custom_omit_levels'] ?? null)
            : null;
        $setting->save();

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'map.render.quality_updated',
            details: [
                'preset' => $setting->quality_preset,
                'tile_size' => $setting->effectiveTileSize(),
                'omit_levels' => $setting->effectiveOmitLevels(),
            ],
            ip: $request->ip(),
        );

        return response()->json([
            'message' => 'Quality settings updated',
            'effective_tile_size' => $setting->effectiveTileSize(),
            'effective_omit_levels' => $setting->effectiveOmitLevels(),
        ]);
    }

    public function updateSchedule(UpdateMapRenderScheduleRequest $request): JsonResponse
    {
        $validated = $request->validated();
        $setting = MapRenderSetting::instance();

        $setting->schedule_preset = $validated['schedule_preset'];
        $setting->cron_expression = $validated['schedule_preset'] === 'custom'
            ? ($validated['cron_expression'] ?? null)
            : null;
        $setting->save();

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'map.render.schedule_updated',
            details: [
                'preset' => $setting->schedule_preset,
                'cron_expression' => $setting->cron_expression,
            ],
            ip: $request->ip(),
        );

        return response()->json([
            'message' => 'Schedule updated',
            'effective_cron' => $setting->effectiveCronExpression(),
        ]);
    }
}
