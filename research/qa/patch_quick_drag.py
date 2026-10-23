import io

p = r'E:\Zilux2开发\web\src\ui\app.ts'
t = io.open(p, 'r', encoding='utf-8', newline='').read()

anchor = '''    const root = h(
      'div',
      { class: 'quick-stepper' },
      button('−', -options.step, '减小'),
      label,
      button('＋', options.step, '增大'),
    );'''
assert t.count(anchor) == 1

addition = '''    // 数值框本身也能左右拖动调整（不用点 +/- 按钮）
    let dragging = false;
    let dragPointer = -1;
    let dragStartX = 0;
    let dragStartValue = 0;
    const span = Math.max(1, options.max - options.min);
    const quantize = (value: number): number => {
      const stepped = Math.round((value - options.min) / options.step) * options.step + options.min;
      return Math.max(options.min, Math.min(options.max, stepped));
    };
    root.addEventListener('pointerdown', (event) => {
      if ((event.target as HTMLElement).closest('.quick-stepper-btn')) return;
      event.preventDefault();
      event.stopPropagation();
      dragging = true;
      dragPointer = event.pointerId;
      dragStartX = event.clientX;
      dragStartValue = current;
      root.classList.add('is-dragging');
      try {
        root.setPointerCapture(event.pointerId);
      } catch {
        /* 忽略 */
      }
    });
    root.addEventListener('pointermove', (event) => {
      if (!dragging || event.pointerId !== dragPointer) return;
      event.preventDefault();
      const dx = event.clientX - dragStartX;
      apply(quantize(dragStartValue + (dx / 180) * span));
    });
    const endDrag = (event: PointerEvent): void => {
      if (!dragging || event.pointerId !== dragPointer) return;
      dragging = false;
      dragPointer = -1;
      root.classList.remove('is-dragging');
      try {
        root.releasePointerCapture(event.pointerId);
      } catch {
        /* 忽略 */
      }
    };
    root.addEventListener('pointerup', endDrag);
    root.addEventListener('pointercancel', endDrag);
'''

t = t.replace(anchor, anchor + addition)
io.open(p, 'w', encoding='utf-8', newline='').write(t)

# CSS
p2 = r'E:\Zilux2开发\web\src\styles\app.css'
c = io.open(p2, 'r', encoding='utf-8', newline='').read()
ceol = '\r\n' if '\r\n' in c else '\n'
c += """
/* 快捷面板数值框：支持在框内左右拖动调整 */
.quick-cell .quick-stepper {
  cursor: ew-resize;
  user-select: none;
  touch-action: none;
}
.quick-cell .quick-stepper.is-dragging {
  border-color: color-mix(in srgb, var(--accent) 46%, transparent);
  background: rgb(var(--overlay-rgb) / 0.09);
}
.quick-cell .quick-stepper.is-dragging .quick-stepper-value {
  color: var(--accent-strong);
}
""".replace('\n', ceol)
io.open(p2, 'w', encoding='utf-8', newline='').write(c)
print('ok')
