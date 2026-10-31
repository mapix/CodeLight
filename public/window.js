export class WindowMirror {
  constructor(container, onCommand) {
    this.container = container; this.onCommand = onCommand;
    this.displayed = null; this.pending = null; this.loading = false; this.zoom = 1;
    this.generation = 0; this.summary = null;
    this.activeBlob = null; this.flight = null;
    container.innerHTML = '<div class="window-caption">共享 ZCode 桌面窗口 · 选择和输入与桌面共用</div><div class="window-tools"><button type="button" data-action="activate">显示桌面窗口</button><button type="button" data-action="zoom">放大画面</button><button type="button" data-key="escape">Esc</button><button type="button" data-key="tab">Tab</button><button type="button" data-key="enter">回车</button></div><div class="window-viewport"><img class="window-image" alt="ZCode 当前桌面窗口"></div><div class="window-tools"><button type="button" data-scroll="up">向上滚动</button><button type="button" data-scroll="down">向下滚动</button></div><div class="window-controls"><label>输入到<select class="window-input"><option value="">先点击画面中的输入框</option></select></label><label>窗口控件<select class="window-control"><option value="">请选择控件</option></select></label><button class="window-press" type="button">操作所选控件</button></div><p class="window-hint">点击画面可操作桌面；放大后可平移查看。填写文字后，请点击 ZCode 窗口中的发送按钮。</p><p class="window-error error" role="alert"></p>';
    this.image = container.querySelector('.window-image');
    this.viewport = container.querySelector('.window-viewport');
    this.input = container.querySelector('.window-input');
    this.control = container.querySelector('.window-control');
    this.error = container.querySelector('.window-error');
    this.textView = document.createElement('pre'); this.textView.className = 'window-text'; this.textView.hidden = true;
    this.viewport.after(this.textView);
    this.image.addEventListener('click', (event) => {
      if (!this.displayed || this.displayed.coordinateControlAvailable === false) return;
      const rect = this.image.getBoundingClientRect(); const bounds = this.displayed.captureStamp.bounds;
      const x = (event.clientX - rect.left) / rect.width * bounds.width;
      const y = (event.clientY - rect.top) / rect.height * bounds.height;
      void this.act('click', { captureStamp: this.displayed.captureStamp, x, y });
    });
    container.querySelector('[data-action=activate]').addEventListener('click', () => {
      const stamp = this.displayed?.captureStamp || this.summary;
      if (stamp?.runtimeGeneration && stamp?.windowGeneration) void this.act('activate', { runtimeGeneration: stamp.runtimeGeneration, windowGeneration: stamp.windowGeneration });
    });
    container.querySelector('[data-action=zoom]').addEventListener('click', () => { this.zoom = this.zoom === 1 ? 2.5 : 1; this.image.style.width = `${this.zoom * 100}%`; });
    container.querySelectorAll('[data-key]').forEach((button) => button.addEventListener('click', () => {
      if (this.displayed && this.displayed.coordinateControlAvailable !== false) void this.act('key', { captureStamp: this.displayed.captureStamp, key: button.dataset.key });
    }));
    container.querySelectorAll('[data-scroll]').forEach((button) => button.addEventListener('click', () => {
      if (!this.displayed || this.displayed.coordinateControlAvailable === false) return; const bounds = this.displayed.captureStamp.bounds;
      void this.act('scroll', { captureStamp: this.displayed.captureStamp, x: bounds.width * .65, y: bounds.height * .55, deltaY: button.dataset.scroll === 'up' ? 300 : -300 });
    }));
    container.querySelector('.window-press').addEventListener('click', () => {
      if (this.displayed && this.control.value) void this.act('press', { captureStamp: this.displayed.captureStamp, nodeId: this.control.value });
    });
  }

  selectWindow(summary) { this.summary = summary; }

  setView(view) {
    if (view.captureMode === 'ax-only' && view.captureStamp && view.semanticControlAvailable) {
      this.generation++; this.flight?.controller.abort(); this.flight = null; this.loading = false; this.pending = null;
      this.image.removeAttribute('src'); if (this.activeBlob) URL.revokeObjectURL(this.activeBlob); this.activeBlob = null;
      this.displayed = view; this.viewport.hidden = true; this.textView.hidden = false;
      const text = (view.axText || []).filter((value, at, all) => typeof value === 'string' && value.trim() && value !== all[at - 1]);
      this.textView.textContent = text.join('\n');
      this.container.querySelector('.window-caption').textContent = 'ZCode 后台窗口 · 文字与语义控件共享';
      this.error.textContent = ''; this.drawControls(view); this.setCoordinateControls(false); return;
    }
    if (!view.imageUrl || !view.captureStamp) {
      this.reset();
      this.error.textContent = view.screenLocked === true ? '请先在电脑上解锁 Mac。' : '桌面窗口暂不可见，请显示窗口或等待恢复。'; return;
    }
    this.viewport.hidden = false; this.textView.hidden = true;
    this.container.querySelector('.window-caption').textContent = '共享 ZCode 桌面窗口 · 选择和输入与桌面共用';
    this.setCoordinateControls(true);
    this.pending = view; this.loadPending();
  }

  setCoordinateControls(enabled) {
    this.container.querySelectorAll('[data-key],[data-scroll],[data-action=zoom]').forEach((button) => { button.disabled = !enabled; });
  }

  async loadPending() {
    if (this.loading || !this.pending) return;
    const view = this.pending; const generation = this.generation;
    this.pending = null; this.loading = true;
    const flight = { controller: new AbortController(), generation }; this.flight = flight;
    let blobUrl = null;
    try {
      const url = new URL(view.imageUrl, location.href);
      if (url.origin !== location.origin || url.pathname !== '/api/window-image') throw Error('invalid-image-address');
      const response = await fetch(url, { cache: 'no-store', signal: flight.controller.signal });
      if (!response.ok) throw Error('frame-expired');
      const blob = await response.blob();
      if (generation !== this.generation) return;
      blobUrl = URL.createObjectURL(blob); this.image.src = blobUrl;
      await this.image.decode();
      if (generation !== this.generation) return;
      // 同一已解码图片与stamp原子启用，不能用新stamp操作旧图片。
      const old = this.activeBlob; this.activeBlob = blobUrl; blobUrl = null;
      if (old) URL.revokeObjectURL(old);
      this.displayed = view; this.error.textContent = ''; this.drawControls(view);
    } catch {
      if (generation === this.generation) { this.displayed = null; this.error.textContent = '窗口画面已更新，正在读取最新画面。'; }
    } finally {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      if (this.flight === flight) { this.flight = null; this.loading = false; void this.loadPending(); }
    }
  }

  drawControls(view) {
    const previousInput = this.input.value, previousControl = this.control.value;
    this.input.replaceChildren(new Option('请选择输入框', '')); this.control.replaceChildren(new Option('请选择控件', ''));
    for (const control of view.controls || []) {
      const label = control.text?.placeholder || control.text?.title || control.text?.description || control.role;
      if (['AXTextArea', 'AXTextField'].includes(control.role)) this.input.append(new Option(label.slice(0, 100), control.nodeId));
      if (control.actions?.includes('AXPress')) this.control.append(new Option(label.slice(0, 100), control.nodeId));
    }
    if ([...this.input.options].some((option) => option.value === previousInput)) this.input.value = previousInput;
    else {
      const focused = (view.controls || []).find((control) => control.focused && ['AXTextArea', 'AXTextField'].includes(control.role));
      if (focused) this.input.value = focused.nodeId;
    }
    if ([...this.control.options].some((option) => option.value === previousControl)) this.control.value = previousControl;
  }

  async act(action, payload) {
    if (!this.displayed && action !== 'activate') { this.error.textContent = '请先等待最新窗口画面。'; return false; }
    this.error.textContent = '';
    const result = await this.onCommand(action, payload);
    if (!result) this.error.textContent = '窗口操作没有确认成功，请刷新画面后再操作。';
    return result;
  }

  async fill(text) {
    if (!this.displayed || !this.input.value) { this.error.textContent = '请先选择 ZCode 窗口中的空输入框。'; return false; }
    return this.act('type', { captureStamp: this.displayed.captureStamp, nodeId: this.input.value, text });
  }

  reset() {
    this.generation++; this.flight?.controller.abort(); this.flight = null; this.displayed = null; this.pending = null; this.summary = null; this.loading = false;
    this.image.removeAttribute('src'); if (this.activeBlob) URL.revokeObjectURL(this.activeBlob); this.activeBlob = null; this.error.textContent = '';
    this.textView.textContent = ''; this.textView.hidden = true; this.viewport.hidden = false;
  }
}
