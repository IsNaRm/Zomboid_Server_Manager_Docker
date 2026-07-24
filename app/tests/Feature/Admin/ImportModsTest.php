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
    @unlink($this->tempDir.'/.config_state');
    @unlink($this->tempDir.'/.config_state.lock');
    @rmdir($this->tempDir.'/Server');
    @rmdir($this->tempDir);
});

it('bulk imports mods, merging into the existing list', function () {
    $response = $this->actingAs($this->admin)->postJson('/admin/mods/import', [
        'mods' => [
            ['workshop_id' => '1111111111', 'mod_id' => 'ModA'],
            ['workshop_id' => '2222222222', 'mod_id' => 'ModB'],
        ],
    ]);

    $response->assertCreated()
        ->assertJson(['restart_required' => true, 'summary' => ['added' => 2, 'skipped' => 0]]);

    $modIds = collect($response->json('mods'))->pluck('mod_id')->all();
    expect($modIds)->toContain('SuperSurvivors', 'Hydrocraft', 'ModA', 'ModB', 'ZomboidManager');
});

it('skips already-installed mods on import', function () {
    $this->actingAs($this->admin)->postJson('/admin/mods/import', [
        'mods' => [
            ['workshop_id' => '2561774086', 'mod_id' => 'SuperSurvivors'],
            ['workshop_id' => '3333333333', 'mod_id' => 'Fresh'],
        ],
    ])
        ->assertCreated()
        ->assertJson(['summary' => ['added' => 1, 'skipped' => 1]]);
});

it('merges a pasted Map line and persists it to .config_state', function () {
    $this->actingAs($this->admin)->postJson('/admin/mods/import', [
        'mods' => [['workshop_id' => '1111111111', 'mod_id' => 'BigMapMod']],
        'map' => ['BigMap', 'Muldraugh, KY'],
    ])->assertCreated();

    expect((new ServerIniParser)->read($this->iniPath)['Map'])->toBe('BigMap;Muldraugh, KY')
        ->and(file_get_contents($this->tempDir.'/.config_state'))->toContain('Map=BigMap;Muldraugh, KY');
});

it('writes an audit log for the import', function () {
    $this->actingAs($this->admin)->postJson('/admin/mods/import', [
        'mods' => [['workshop_id' => '1111111111', 'mod_id' => 'ModA']],
    ])->assertCreated();

    $log = AuditLog::query()->where('action', 'mod.import')->first();

    expect($log)->not->toBeNull()
        ->and($log->actor)->toBe($this->admin->name)
        ->and($log->target)->toBe('server.ini');
});

it('rejects the import for guests', function () {
    $this->postJson('/admin/mods/import', [
        'mods' => [['workshop_id' => '1111111111', 'mod_id' => 'ModA']],
    ])->assertUnauthorized();
});

it('rejects an invalid workshop id', function () {
    $this->actingAs($this->admin)->postJson('/admin/mods/import', [
        'mods' => [['workshop_id' => 'not-a-number', 'mod_id' => 'ModA']],
    ])->assertUnprocessable();
});

it('rejects a batch larger than the cap', function () {
    $mods = [];
    for ($i = 0; $i < 601; $i++) {
        $mods[] = ['workshop_id' => (string) (1000000000 + $i), 'mod_id' => 'Mod'.$i];
    }

    $this->actingAs($this->admin)->postJson('/admin/mods/import', ['mods' => $mods])
        ->assertUnprocessable();
});
