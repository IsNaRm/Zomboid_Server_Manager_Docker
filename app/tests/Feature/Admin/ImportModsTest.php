<?php

use App\Models\AuditLog;
use App\Models\User;
use App\Services\ServerIniParser;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->admin = User::factory()->admin()->create();
    $this->tempDir = sys_get_temp_dir().'/pz_import_test_'.uniqid();
    mkdir($this->tempDir.'/Server', 0777, true);
    $this->iniPath = $this->tempDir.'/Server/ZomboidServer.ini';
    copy(base_path('tests/fixtures/server.ini'), $this->iniPath);
    config(['zomboid.paths.server_ini' => $this->iniPath]);
});

afterEach(function () {
    @unlink($this->tempDir.'/Server/.mod_state');
    @unlink($this->tempDir.'/Server/.mod_state_applied');
    @unlink($this->iniPath);
    @unlink($this->tempDir.'/Server/.config_state');
    @unlink($this->tempDir.'/Server/.config_state.lock');
    @rmdir($this->tempDir.'/Server');
    @rmdir($this->tempDir);
});

it('bulk imports independent mod and workshop lists, merging into existing', function () {
    $response = $this->actingAs($this->admin)->postJson('/admin/mods/import', [
        'workshop_ids' => ['1111111111', '2222222222'],
        'mod_ids' => ['ModA', 'ModB', 'ModC'],
    ]);

    $response->assertCreated()
        ->assertJson(['restart_required' => true, 'summary' => ['workshop_added' => 2, 'mods_added' => 3]]);

    $modIds = collect($response->json('mods'))->pluck('mod_id')->all();
    expect($modIds)->toContain('SuperSurvivors', 'Hydrocraft', 'ModA', 'ModB', 'ModC', 'ZomboidManager');
});

it('skips already-installed entries on import', function () {
    $this->actingAs($this->admin)->postJson('/admin/mods/import', [
        'workshop_ids' => ['2561774086', '3333333333'],
        'mod_ids' => ['SuperSurvivors', 'Fresh'],
    ])
        ->assertCreated()
        ->assertJson(['summary' => ['workshop_added' => 1, 'mods_added' => 1]]);
});

it('accepts real B42 mod IDs with brackets, ampersands and slashes', function () {
    $this->actingAs($this->admin)->postJson('/admin/mods/import', [
        'mod_ids' => ['[B42] Tatrapan', 'FWOBenchPress&Treadmill', '1299328280/ToadTraits'],
    ])->assertCreated();

    $mods = (new ServerIniParser)->read($this->iniPath)['Mods'];
    expect($mods)->toContain('[B42] Tatrapan', 'FWOBenchPress&Treadmill', '1299328280/ToadTraits');
});

it('merges a pasted Map line and persists it to .config_state', function () {
    $this->actingAs($this->admin)->postJson('/admin/mods/import', [
        'mod_ids' => ['BigMapMod'],
        'map' => ['BigMap', 'Muldraugh, KY'],
    ])->assertCreated();

    expect((new ServerIniParser)->read($this->iniPath)['Map'])->toBe('BigMap;Muldraugh, KY')
        ->and(file_get_contents($this->tempDir.'/Server/.config_state'))->toContain('Map=BigMap;Muldraugh, KY');
});

it('writes an audit log for the import', function () {
    $this->actingAs($this->admin)->postJson('/admin/mods/import', [
        'mod_ids' => ['ModA'],
    ])->assertCreated();

    $log = AuditLog::query()->where('action', 'mod.import')->first();

    expect($log)->not->toBeNull()
        ->and($log->actor)->toBe($this->admin->name)
        ->and($log->target)->toBe('server.ini');
});

it('rejects the import for guests', function () {
    $this->postJson('/admin/mods/import', [
        'mod_ids' => ['ModA'],
    ])->assertUnauthorized();
});

it('rejects a payload with nothing to import', function () {
    $this->actingAs($this->admin)->postJson('/admin/mods/import', [
        'map' => ['SomeMap'],
    ])->assertUnprocessable();
});

it('rejects an invalid workshop id', function () {
    $this->actingAs($this->admin)->postJson('/admin/mods/import', [
        'workshop_ids' => ['not-a-number'],
    ])->assertUnprocessable();
});

it('rejects a mod id containing the list separator', function () {
    $this->actingAs($this->admin)->postJson('/admin/mods/import', [
        'mod_ids' => ['Evil;Injected'],
    ])->assertUnprocessable();
});

it('rejects a batch larger than the cap', function () {
    $modIds = [];
    for ($i = 0; $i < 1001; $i++) {
        $modIds[] = 'Mod'.$i;
    }

    $this->actingAs($this->admin)->postJson('/admin/mods/import', ['mod_ids' => $modIds])
        ->assertUnprocessable();
});
