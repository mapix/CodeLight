import type { Message } from '@/sync/typesMessage';
/** Keep turn boundaries when close; an exceptionally long run must not defeat the phone's initial window. */
export function messageWindowEnd(messages: Message[], desiredEnd: number, bounded: boolean): number {
    let end = Math.min(desiredEnd, messages.length);
    const limit = bounded ? Math.min(messages.length, end + 60) : messages.length;
    while (end > 0 && end < limit) {
        const message = messages[end - 1];
        if (message.kind === 'user-text' && !message.pending && message.sendError === undefined) break;
        end++;
    }
    return end;
}
