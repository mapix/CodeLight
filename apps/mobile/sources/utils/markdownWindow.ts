/** Bound native Markdown layout without modifying the original copy/download content. */
export function markdownWindow(text: string, limit: number): string {
    if (text.length <= limit) return text;
    let end = limit;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    return text.slice(0, end);
}
