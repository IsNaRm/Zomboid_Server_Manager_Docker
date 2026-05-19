<?php

namespace App\Console\Commands;

use App\Models\MapRenderSetting;
use App\Services\AuditLogger;
use Illuminate\Console\Command;
use Symfony\Component\Process\Process;

class BuildAtlasCommand extends Command
{
    /** @var string */
    protected $signature = 'zomboid:build-atlas
        {--input= : Directory containing .pack files (default: zomboid.map.texturepacks_path)}
        {--output= : Output directory for atlas (default: <tiles_path>/web)}
        {--atlas-size=4096 : Edge size of each atlas page in pixels}
        {--max-mip=10 : Maximum mip-level depth (down to 1x1 by default)}
        {--include-pack=* : Substring filter for .pack filenames; repeatable. Pass once with "" to include everything.}
        {--all : Shortcut for --include-pack="" — include every .pack found}';

    /** @var string */
    protected $description = 'Build mip-mapped sprite atlas (WebP) from PZ texturepacks for the WebGL renderer';

    public function handle(): int
    {
        $script = base_path('scripts/pzpack_to_atlas.py');

        if (! is_file($script)) {
            $this->error("Atlas builder script missing: {$script}");

            return self::FAILURE;
        }

        $input = (string) ($this->option('input')
            ?: config('zomboid.map.texturepacks_path', '/pz-data/texturepacks'));
        $output = (string) ($this->option('output')
            ?: rtrim((string) config('zomboid.map.tiles_path', '/map-tiles'), '/').'/web');

        if (! is_dir($input)) {
            $this->error("Input directory does not exist: {$input}");

            return self::FAILURE;
        }

        $args = [
            'python3', $script,
            '--input', $input,
            '--output', $output,
            '--atlas-size', (string) $this->option('atlas-size'),
            '--max-mip', (string) $this->option('max-mip'),
        ];

        if ($this->option('all')) {
            $args[] = '--include-pack';
            $args[] = '';
        } else {
            foreach ((array) $this->option('include-pack') as $pattern) {
                $args[] = '--include-pack';
                $args[] = (string) $pattern;
            }
        }

        $this->info("Running: {$args[0]} {$args[1]} ...");
        $this->line("Input:  {$input}");
        $this->line("Output: {$output}");
        $this->line('');

        $process = new Process($args);
        $process->setTimeout(3600);
        $process->setIdleTimeout(900);

        $exitCode = $process->run(function (string $type, string $buffer): void {
            $this->output->write($buffer);
        });

        if ($exitCode !== 0) {
            $this->error("Atlas builder failed with exit code {$exitCode}");

            return self::FAILURE;
        }

        $manifestPath = $output.'/manifest.json';

        if (is_file($manifestPath)) {
            $manifest = json_decode((string) file_get_contents($manifestPath), true);

            if (is_array($manifest)) {
                $this->line('');
                $this->info('Atlas summary:');
                $this->line('  version:      '.($manifest['version'] ?? '?'));
                $this->line('  atlas pages:  '.($manifest['atlas_count'] ?? '?'));
                $this->line('  sprites:      '.($manifest['sprite_count'] ?? '?'));
                $this->line('  total bytes:  '.number_format((int) ($manifest['total_bytes'] ?? 0)));

                $setting = MapRenderSetting::instance();
                $setting->forceFill([
                    'atlas_built_at' => now(),
                    'atlas_version' => (string) ($manifest['version'] ?? ''),
                    'atlas_size_bytes' => (int) ($manifest['total_bytes'] ?? 0),
                    'atlas_sprite_count' => (int) ($manifest['sprite_count'] ?? 0),
                    'atlas_page_count' => (int) ($manifest['atlas_count'] ?? 0),
                ])->save();

                AuditLogger::record(
                    actor: 'system',
                    action: 'map.atlas.built',
                    target: (string) ($manifest['version'] ?? ''),
                    details: [
                        'sprite_count' => $manifest['sprite_count'] ?? 0,
                        'atlas_count' => $manifest['atlas_count'] ?? 0,
                        'total_bytes' => $manifest['total_bytes'] ?? 0,
                    ],
                );
            }
        }

        return self::SUCCESS;
    }
}
