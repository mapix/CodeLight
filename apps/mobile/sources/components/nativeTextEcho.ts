/** Native text owns keystrokes. This remembers unacknowledged echoes, never the user's persistent draft. */
export class NativeTextEcho {
    private echoes: { text: string; eventCount: number }[] = [];
    private lastEventCount = 0;

    record(text: string, eventCount: number): void {
        if (eventCount < this.lastEventCount) return;
        this.lastEventCount = eventCount;
        this.echoes.push({ text, eventCount });
        if (this.echoes.length > 256) this.echoes.splice(0, this.echoes.length - 256);
    }

    acknowledge(text: string): boolean {
        // 同一个字符串可能经历输入/删除后再次出现；确认最新匹配，不能留下更旧回显吞掉下一次外部编辑。
        let at = -1;
        for (let index = this.echoes.length - 1; index >= 0; index--) {
            if (this.echoes[index].text === text) { at = index; break; }
        }
        if (at < 0) return false;
        this.echoes.splice(0, at + 1);
        return true;
    }

    externalWrite(): void { this.echoes = []; }
}
