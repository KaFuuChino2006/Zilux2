# -*- coding: utf-8 -*-
"""spaceShell：右侧「自定义外观」入口 + 独立面板（玻璃厚度 / 通透度 / 空间背景图）。"""
import io

p = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# ---------- 1) 模板：右侧按钮 ----------
anchor_side = """    </div>
    <div class="space-brand">"""
new_side = """    </div>
    <div class="space-side">
      <button class="space-side-btn" data-custom type="button" aria-label="自定义外观" title="自定义外观">${icon('edit', 18)}</button>
    </div>
    <div class="space-brand">"""
assert s.count(anchor_side) == 1
s = s.replace(anchor_side, new_side, 1)

# ---------- 2) 模板：自定义面板 ----------
anchor_sheet = """    </div>
  `;
  document.body.appendChild(root);"""
new_sheet = """    </div>
    <div class="custom-sheet" data-custom-sheet hidden>
      <div class="custom-sheet-backdrop" data-custom-close></div>
      <div class="custom-sheet-card" role="dialog" aria-modal="true" aria-label="自定义外观">
        <header class="custom-sheet-head">
          <div>
            <h2>自定义外观</h2>
            <p>玻璃厚度、通透度与空间背景图，只影响本机显示</p>
          </div>
          <button class="custom-sheet-close" data-custom-close type="button" aria-label="关闭">${WIN_CLOSE}</button>
        </header>
        <div class="custom-body">
          <div class="custom-row">
            <div class="custom-label"><span>玻璃厚度</span><b data-thickness-value>0.62</b></div>
            <input class="custom-slider" data-thickness type="range" min="0.10" max="1.60" step="0.02" value="0.62" aria-label="玻璃厚度" />
            <p class="custom-tip">厚玻璃的侧壁高度，小玻璃片会一起变厚</p>
          </div>
          <div class="custom-row">
            <div class="custom-label"><span>玻璃通透度</span><b data-transmission-value>94%</b></div>
            <input class="custom-slider" data-transmission type="range" min="30" max="100" step="1" value="94" aria-label="玻璃通透度" />
            <p class="custom-tip">越高越透明；越低越接近磨砂玻璃</p>
          </div>
          <div class="custom-row">
            <div class="custom-label"><span>空间背景图</span></div>
            <div class="custom-image">
              <div class="custom-preview" data-custom-preview><span>未选择图片</span></div>
              <div class="custom-image-actions">
                <label class="custom-btn" for="space-underlay-input">选择图片</label>
                <input id="space-underlay-input" class="custom-file" data-underlay-input type="file" accept="image/png,image/jpeg,image/webp" hidden />
                <button class="custom-btn is-quiet" data-underlay-clear type="button">清除</button>
              </div>
            </div>
            <p class="custom-tip">显示在玻璃下方；建议横向图片，会自动压缩到 1600px 内</p>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(root);"""
assert s.count(anchor_sheet) == 1
s = s.replace(anchor_sheet, new_sheet, 1)

# ---------- 3) 元素引用 ----------
anchor_refs = """  const accountSheet = root.querySelector<HTMLElement>('[data-account-sheet]')!;
  const accountList = root.querySelector<HTMLElement>('[data-account-list]')!;"""
new_refs = """  const accountSheet = root.querySelector<HTMLElement>('[data-account-sheet]')!;
  const accountList = root.querySelector<HTMLElement>('[data-account-list]')!;
  const customSheet = root.querySelector<HTMLElement>('[data-custom-sheet]')!;
  const customPreview = root.querySelector<HTMLElement>('[data-custom-preview]')!;
  const thicknessInput = root.querySelector<HTMLInputElement>('[data-thickness]')!;
  const thicknessValue = root.querySelector<HTMLElement>('[data-thickness-value]')!;
  const transmissionInput = root.querySelector<HTMLInputElement>('[data-transmission]')!;
  const transmissionValue = root.querySelector<HTMLElement>('[data-transmission-value]')!;
  const underlayInput = root.querySelector<HTMLInputElement>('[data-underlay-input]')!;
  const underlayClear = root.querySelector<HTMLButtonElement>('[data-underlay-clear]')!;
  const customOpenBtn = root.querySelector<HTMLButtonElement>('[data-custom]')!;"""
assert s.count(anchor_refs) == 1
s = s.replace(anchor_refs, new_refs, 1)

# ---------- 4) 自定义逻辑（插在左侧功能栏绑定之前） ----------
anchor_logic = """  /* 左侧常用功能栏：账号（已实现）+ 歌单 / 搜索 / 设置（后续里程碑） */"""
new_logic = """  /* 右侧「自定义外观」：玻璃厚度 / 通透度 / 空间背景图（与设置面板分开，本机持久化） */
  const CUSTOM_KEY = 'zilux2.space.custom';
  const DEFAULT_CUSTOM = { thickness: 0.62, transmission: 0.94, image: null as string | null };
  const loadCustom = (): typeof DEFAULT_CUSTOM => {
    try {
      const raw = window.localStorage.getItem(CUSTOM_KEY);
      if (!raw) return { ...DEFAULT_CUSTOM };
      const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_CUSTOM>;
      const thickness =
        typeof parsed.thickness === 'number' && Number.isFinite(parsed.thickness)
          ? Math.min(1.6, Math.max(0.1, parsed.thickness))
          : DEFAULT_CUSTOM.thickness;
      const transmission =
        typeof parsed.transmission === 'number' && Number.isFinite(parsed.transmission)
          ? Math.min(1, Math.max(0.3, parsed.transmission))
          : DEFAULT_CUSTOM.transmission;
      const image =
        typeof parsed.image === 'string' && parsed.image.startsWith('data:image/') ? parsed.image : null;
      return { thickness, transmission, image };
    } catch {
      return { ...DEFAULT_CUSTOM };
    }
  };
  const custom = loadCustom();
  let customSaveTimer = 0;
  const persistCustom = (): void => {
    window.clearTimeout(customSaveTimer);
    customSaveTimer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
      } catch {
        showToast('背景图较大，未能保存到本机（本次仍生效）', 'warn');
      }
    }, 320);
  };
  const applyCustom = (): void => {
    space?.setGlassThickness(custom.thickness);
    space?.setGlassTransmission(custom.transmission);
    space?.setUnderlayImage(custom.image);
  };
  const syncCustomUi = (): void => {
    thicknessInput.value = custom.thickness.toFixed(2);
    thicknessValue.textContent = custom.thickness.toFixed(2);
    transmissionInput.value = String(Math.round(custom.transmission * 100));
    transmissionValue.textContent = `${Math.round(custom.transmission * 100)}%`;
    if (custom.image) {
      customPreview.classList.add('has-image');
      customPreview.style.backgroundImage = `url("${custom.image}")`;
      customPreview.innerHTML = '<span></span>';
    } else {
      customPreview.classList.remove('has-image');
      customPreview.style.backgroundImage = '';
      customPreview.innerHTML = '<span>未选择图片</span>';
    }
  };
  const openCustomSheet = (): void => {
    customSheet.hidden = false;
    syncCustomUi();
    window.requestAnimationFrame(() => customSheet.classList.add('is-open'));
  };
  const closeCustomSheet = (): void => {
    customSheet.classList.remove('is-open');
    customSheet.hidden = true;
  };
  const readImageFile = async (file: File): Promise<string> => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error ?? new Error('read failed'));
      reader.readAsDataURL(file);
    });
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('decode failed'));
      el.src = dataUrl;
    });
    const maxWidth = 1600;
    const scale = Math.min(1, maxWidth / image.naturalWidth);
    const out = document.createElement('canvas');
    out.width = Math.max(2, Math.round(image.naturalWidth * scale));
    out.height = Math.max(2, Math.round(image.naturalHeight * scale));
    const ctx = out.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.85);
  };

  customOpenBtn.addEventListener('click', openCustomSheet);
  customSheet.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('[data-custom-close]')) closeCustomSheet();
  });
  thicknessInput.addEventListener('input', () => {
    custom.thickness = Number.parseFloat(thicknessInput.value);
    thicknessValue.textContent = custom.thickness.toFixed(2);
    applyCustom();
    persistCustom();
  });
  transmissionInput.addEventListener('input', () => {
    custom.transmission = Math.min(1, Math.max(0.3, Number.parseInt(transmissionInput.value, 10) / 100));
    transmissionValue.textContent = `${Math.round(custom.transmission * 100)}%`;
    applyCustom();
    persistCustom();
  });
  underlayClear.addEventListener('click', () => {
    custom.image = null;
    applyCustom();
    syncCustomUi();
    persistCustom();
    showToast('已清除空间背景图', 'info');
  });
  underlayInput.addEventListener('change', () => {
    const file = underlayInput.files?.[0];
    underlayInput.value = '';
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      showToast('图片超过 12MB，请换一张小一点的', 'warn');
      return;
    }
    void readImageFile(file)
      .then((url) => {
        custom.image = url;
        applyCustom();
        syncCustomUi();
        persistCustom();
        showToast('已更新空间背景图', 'ok');
      })
      .catch(() => showToast('这张图片无法读取，请换一张试试', 'error'));
  });

  /* 左侧常用功能栏：账号（已实现）+ 歌单 / 搜索 / 设置（后续里程碑） */"""
assert s.count(anchor_logic) == 1
s = s.replace(anchor_logic, new_logic, 1)

# ---------- 5) space.start() 后应用自定义 + QA 参数 ----------
anchor_start = """  space.start();
  const offView = space.onView(drawCompass);"""
new_start = """  space.start();
  applyCustom();
  syncCustomUi();
  const offView = space.onView(drawCompass);"""
assert s.count(anchor_start) == 1
s = s.replace(anchor_start, new_start, 1)

anchor_qa = """  // QA：?panel=account 直接打开账号面板（配合 ?mock=1 做界面验收）
  if (params.get('panel') === 'account') {
    window.setTimeout(() => {
      if (!disposed) openAccountSheet();
    }, 600);
  }"""
new_qa = """  // QA：?panel=account 直接打开账号面板（配合 ?mock=1 做界面验收）
  if (params.get('panel') === 'account') {
    window.setTimeout(() => {
      if (!disposed) openAccountSheet();
    }, 600);
  }
  // QA：?panel=custom 直接打开自定义外观面板
  if (params.get('panel') === 'custom') {
    window.setTimeout(() => {
      if (!disposed) openCustomSheet();
    }, 600);
  }"""
assert s.count(anchor_qa) == 1
s = s.replace(anchor_qa, new_qa, 1)

# ---------- 6) Esc 关闭自定义面板 ----------
anchor_esc = """    if (event.key === 'Escape' && !accountSheet.hidden) {
      event.preventDefault();
      closeAccountSheet();
      return;
    }"""
new_esc = """    if (event.key === 'Escape' && !customSheet.hidden) {
      event.preventDefault();
      closeCustomSheet();
      return;
    }
    if (event.key === 'Escape' && !accountSheet.hidden) {
      event.preventDefault();
      closeAccountSheet();
      return;
    }"""
assert s.count(anchor_esc) == 1
s = s.replace(anchor_esc, new_esc, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('custom sheet wired')
