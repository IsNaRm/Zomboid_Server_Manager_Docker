/**
 * Полноэкранный overlay показывающий прогресс инициализации карты.
 * Активен пока renderer.state !== 'ready'.
 */

import type { ProgressSnapshot } from '@/lib/pz-renderer';

interface Props {
    progress: ProgressSnapshot | null;
}

export function PzMapPreloader({ progress }: Props) {
    const pct = progress ? Math.round(progress.overall * 100) : 0;
    const label = progress?.label ?? 'Подключение...';
    const eta = progress?.details?.etaSeconds;

    return (
        <div className="absolute inset-0 z-[1000] flex flex-col items-center justify-center bg-zinc-950/85 text-zinc-100 backdrop-blur-sm">
            <div className="w-80 max-w-[80%] space-y-3">
                <div className="flex items-baseline justify-between">
                    <span className="text-sm font-medium">{label}</span>
                    <span className="font-mono text-xs text-zinc-400">{pct}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                    <div
                        className="h-full bg-emerald-500 transition-[width] duration-150 ease-out"
                        style={{ width: `${pct}%` }}
                    />
                </div>
                {eta !== undefined && eta > 0 && (
                    <p className="text-center text-xs text-zinc-500">
                        ~{Math.ceil(eta)} сек осталось
                    </p>
                )}
                <p className="text-center text-xs text-zinc-500">
                    Первая загрузка скачивает атлас и данные карты целиком.
                    Следующие визиты будут мгновенными благодаря кэшу в браузере.
                </p>
            </div>
        </div>
    );
}
