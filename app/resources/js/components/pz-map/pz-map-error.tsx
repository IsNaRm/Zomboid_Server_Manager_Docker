/**
 * Полноэкранный UI для фатальных ошибок рендерера (WebGL2 not supported,
 * network failure, etc.).
 */

interface Props {
    error: Error;
    onRetry?: () => void;
}

export function PzMapError({ error, onRetry }: Props) {
    const isWebGlError = error.name === 'WebGL2NotSupportedError';
    return (
        <div className="absolute inset-0 z-[1000] flex items-center justify-center bg-zinc-950/95 text-zinc-100">
            <div className="max-w-md space-y-4 rounded-lg border border-red-800 bg-red-950/40 p-6">
                <h2 className="text-lg font-semibold text-red-300">
                    {isWebGlError ? 'WebGL2 недоступен' : 'Ошибка загрузки карты'}
                </h2>
                <p className="text-sm text-zinc-300">{error.message}</p>
                {isWebGlError && (
                    <p className="text-xs text-zinc-400">
                        Карта требует браузер с поддержкой WebGL 2.0. Минимальные
                        требования: Chrome 56+, Firefox 51+, Safari 15+, Edge 79+.
                    </p>
                )}
                {onRetry && (
                    <button
                        onClick={onRetry}
                        className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-600"
                    >
                        Попробовать снова
                    </button>
                )}
            </div>
        </div>
    );
}
