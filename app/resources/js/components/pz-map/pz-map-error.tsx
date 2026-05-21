/**
 * Полноэкранный UI для фатальных ошибок рендерера. Распознаёт:
 *   - WebGL2NotSupportedError
 *   - QuotaExceededError (IDB полна)
 *   - "Cancelled by user" (user через preloader cancel button)
 *   - Network / parse failures (generic)
 */

interface Props {
    error: Error;
    onRetry?: () => void;
}

type ErrorKind = 'webgl' | 'quota' | 'cancelled' | 'network' | 'generic';

function classifyError(error: Error): ErrorKind {
    if (error.name === 'WebGL2NotSupportedError') return 'webgl';
    if (error.name === 'QuotaExceededError'
        || /quota/i.test(error.message)) return 'quota';
    if (/cancel/i.test(error.message)) return 'cancelled';
    if (/network|fetch|http/i.test(error.message)) return 'network';
    return 'generic';
}

const TITLES: Record<ErrorKind, string> = {
    webgl: 'WebGL2 недоступен',
    quota: 'Кончилось место в кэше браузера',
    cancelled: 'Загрузка отменена',
    network: 'Ошибка сети',
    generic: 'Ошибка загрузки карты',
};

const HINTS: Record<ErrorKind, string> = {
    webgl: 'Карта требует браузер с поддержкой WebGL 2.0. Минимальные '
        + 'требования: Chrome 56+, Firefox 51+, Safari 15+, Edge 79+.',
    quota: 'Браузеру не хватает места под IndexedDB кэш. Очисти кэш сайта '
        + 'в настройках браузера ИЛИ разреши persistent storage. После — '
        + 'обнови страницу.',
    cancelled: 'Загрузка прервана пользователем. Нажми «Перезагрузить» чтобы '
        + 'начать заново.',
    network: 'Не удалось скачать данные карты с сервера. Проверь подключение '
        + 'и перезагрузи страницу.',
    generic: 'Что-то пошло не так. Попробуй обновить страницу. Если ошибка '
        + 'повторяется — открой dev tools и посмотри console.',
};

export function PzMapError({ error, onRetry }: Props) {
    const kind = classifyError(error);
    const title = TITLES[kind];
    const hint = HINTS[kind];
    const isCancelled = kind === 'cancelled';
    return (
        <div className="absolute inset-0 z-[1000] flex items-center justify-center bg-zinc-950/95 text-zinc-100">
            <div
                className={`max-w-md space-y-4 rounded-lg border p-6 ${
                    isCancelled
                        ? 'border-amber-800 bg-amber-950/30'
                        : 'border-red-800 bg-red-950/40'
                }`}
            >
                <h2
                    className={`text-lg font-semibold ${
                        isCancelled ? 'text-amber-300' : 'text-red-300'
                    }`}
                >
                    {title}
                </h2>
                <p className="text-sm text-zinc-300">{error.message}</p>
                <p className="text-xs text-zinc-400">{hint}</p>
                <div className="flex gap-2">
                    {onRetry && (
                        <button
                            type="button"
                            onClick={onRetry}
                            className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-600"
                        >
                            Попробовать снова
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => window.location.reload()}
                        className="rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-zinc-700"
                    >
                        Перезагрузить страницу
                    </button>
                </div>
            </div>
        </div>
    );
}
