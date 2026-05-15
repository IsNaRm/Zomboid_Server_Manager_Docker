<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\AddModRequest;
use App\Http\Requests\Admin\LookupWorkshopModRequest;
use App\Services\AuditLogger;
use App\Services\DockerManager;
use App\Services\ModManager;
use App\Services\SteamWorkshopClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Inertia\Inertia;
use Inertia\Response;
use RuntimeException;

class ModController extends Controller
{
    public function __construct(
        private readonly ModManager $modManager,
        private readonly AuditLogger $auditLogger,
        private readonly DockerManager $dockerManager,
        private readonly SteamWorkshopClient $workshopClient,
    ) {}

    public function index(): Response
    {
        $mods = [];
        $pendingRestart = false;
        $serverRunning = false;

        try {
            $serverRunning = (bool) ($this->dockerManager->getContainerStatus()['running'] ?? false);
        } catch (\Throwable) {
            // Docker socket unreachable — treat server as stopped, keep rendering
        }

        try {
            $status = $this->modManager->listWithStatus(
                config('zomboid.paths.server_ini'),
                $serverRunning,
            );
            $mods = $status['mods'];
            $pendingRestart = $status['pending_restart'];
        } catch (\Throwable) {
            // Config not available — render empty list rather than 500
        }

        return Inertia::render('admin/mods', [
            'mods' => $mods,
            'protectedWorkshopIds' => ModManager::PROTECTED_WORKSHOP_IDS,
            'pendingRestart' => $pendingRestart,
            'serverRunning' => $serverRunning,
        ]);
    }

    public function lookup(LookupWorkshopModRequest $request): JsonResponse
    {
        $workshopId = $request->validated('workshop_id');
        $details = $this->workshopClient->getDetails($workshopId);

        if ($details === null) {
            return response()->json([
                'found' => false,
                'workshop_id' => $workshopId,
            ], 404);
        }

        return response()->json([
            'found' => true,
            'workshop_id' => $details['workshop_id'],
            'title' => $details['title'],
            'preview_url' => $details['preview_url'],
            'mod_ids' => $details['mod_ids'],
            'map_folders' => $details['map_folders'],
        ]);
    }

    public function store(AddModRequest $request): JsonResponse
    {
        $workshopId = $request->validated('workshop_id');
        $modIds = $request->validated('mod_ids');
        $mapFolder = $request->validated('map_folder');

        try {
            $this->modManager->add(
                config('zomboid.paths.server_ini'),
                $workshopId,
                $modIds,
                $mapFolder,
            );
        } catch (RuntimeException $e) {
            Log::error('Failed to add mod', [
                'exception' => $e,
                'workshop_id' => $workshopId,
                'mod_ids' => $modIds,
            ]);

            return response()->json([
                'error' => 'Could not save mod to server config.',
            ], 500);
        }

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'mod.add',
            target: $workshopId,
            details: [
                'workshop_id' => $workshopId,
                'mod_ids' => $modIds,
                'map_folder' => $mapFolder,
            ],
            ip: $request->ip(),
        );

        return response()->json([
            'added' => [
                'workshop_id' => $workshopId,
                'mod_ids' => $modIds,
            ],
            'restart_required' => true,
        ], 201);
    }

    public function destroy(Request $request, string $workshopId): JsonResponse
    {
        if (ModManager::isProtected($workshopId)) {
            return response()->json([
                'error' => 'This mod is required by the manager and cannot be removed.',
            ], 422);
        }

        $modId = $request->query('mod_id') ?? $request->input('mod_id');
        $modId = is_string($modId) && $modId !== '' ? $modId : null;

        try {
            $removed = $this->modManager->remove(
                config('zomboid.paths.server_ini'),
                $workshopId,
                $modId,
            );
        } catch (RuntimeException $e) {
            Log::error('Failed to remove mod', ['exception' => $e, 'workshop_id' => $workshopId]);

            return response()->json([
                'error' => 'Could not save mod removal to server config.',
            ], 500);
        }

        if (! $removed) {
            return response()->json(['error' => 'Mod not found'], 404);
        }

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'mod.remove',
            target: $workshopId,
            details: $removed,
            ip: $request->ip(),
        );

        return response()->json([
            'removed' => $removed,
            'restart_required' => true,
        ]);
    }

    public function reorder(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'mods' => 'required|array',
            'mods.*.workshop_id' => 'required|string',
            'mods.*.mod_id' => 'required|string',
        ]);

        try {
            $this->modManager->reorder(
                config('zomboid.paths.server_ini'),
                $validated['mods'],
            );
        } catch (RuntimeException $e) {
            Log::error('Failed to reorder mods', ['exception' => $e]);

            return response()->json([
                'error' => 'Could not save mod order to server config.',
            ], 500);
        }

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'mod.reorder',
            details: ['count' => count($validated['mods'])],
            ip: $request->ip(),
        );

        $serverRunning = (bool) ($this->dockerManager->getContainerStatus()['running'] ?? false);
        $status = $this->modManager->listWithStatus(
            config('zomboid.paths.server_ini'),
            $serverRunning,
        );

        return response()->json([
            'mods' => $status['mods'],
            'pending_restart' => $status['pending_restart'],
            'restart_required' => true,
        ]);
    }
}
