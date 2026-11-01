/** React Native supplies the instance AbortController API, without DOM static helpers. */
export function abortBudget(parent: AbortSignal | null | undefined, milliseconds: number) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort);
    const timer = setTimeout(abort, milliseconds);
    return { signal: controller.signal, abort, dispose: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
}
