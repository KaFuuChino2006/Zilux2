"""背景粒子（第二段）：加载解析 / 下发 / 同步 / 交互，改为每种效果各自参数。"""
import re
from pathlib import Path

SHELL = Path(r"E:\Zilux2开发\web\src\ui\spaceShell.ts")
ok = []


def sub(pattern: str, repl: str, tag: str):
    text = SHELL.read_text(encoding="utf-8")
    new, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    assert n == 1, f"{tag}: no match"
    SHELL.write_text(new, encoding="utf-8")
    ok.append(tag)


FX_LOAD = '''        fxModes: (() => {
          const allowed = new Set(['stars', 'links', 'triangles', 'dust']);
          if (Array.isArray(parsed.fxModes)) {
            return parsed.fxModes.filter((m): m is string => typeof m === 'string' && allowed.has(m));
          }
          if (typeof parsed.fxMode === 'string') {
            return parsed.fxMode
              .split(',')
              .map((m) => m.trim())
              .filter((m) => allowed.has(m));
          }
          return [...DEFAULT_CUSTOM.fxModes];
        })(),
        fx: (() => {
          const fallback = DEFAULT_CUSTOM.fx;
          const raw = parsed.fx as Record<string, unknown> | undefined;
          const read = (group: string, field: string): number => {
            const bag = raw?.[group] as Record<string, unknown> | undefined;
            const spec = FX_UI[group + '.' + field];
            const base = (fallback as unknown as Record<string, Record<string, number>>)[group][field];
            if (!spec) return base;
            const n = Number(bag?.[field]);
            if (!Number.isFinite(n)) return base;
            return Math.min(spec.max, Math.max(spec.min, spec.digits === 0 ? Math.round(n) : Math.round(n * 10) / 10));
          };
          return {
            stars: {
              count: read('stars', 'count'),
              speed: read('stars', 'speed'),
              size: read('stars', 'size'),
              opacity: read('stars', 'opacity'),
              spin: read('stars', 'spin'),
            },
            links: {
              count: read('links', 'count'),
              speed: read('links', 'speed'),
              size: read('links', 'size'),
              opacity: read('links', 'opacity'),
              link: read('links', 'link'),
              flow: read('links', 'flow'),
            },
            triangles: {
              count: read('triangles', 'count'),
              speed: read('triangles', 'speed'),
              size: read('triangles', 'size'),
              opacity: read('triangles', 'opacity'),
              spin: read('triangles', 'spin'),
            },
            dust: {
              count: read('dust', 'count'),
              size: read('dust', 'size'),
              brightness: read('dust', 'brightness'),
              speed: read('dust', 'speed'),
            },
          };
        })(),'''

sub(r"        fxModes: \(\(\) => \{.*?: DEFAULT_CUSTOM\.fxLink,", FX_LOAD, "fx-load")

FX_APPLY = '''  // ---------- 背景粒子层：星点 / 连线 / 三角 / 星尘，每种效果各自一套参数 ----------
  function applyFxSetting(): void {
    syncFxPanels();
    if (!space) return;
    const gold = root.classList.contains('theme-gold');
    const fx = custom.fx;
    space.setBgFx({
      modes: custom.fxModes,
      color: gold ? '#d9c07a' : '#3a4152',
      stars: {
        count: fx.stars.count,
        speed: fx.stars.speed,
        size: fx.stars.size,
        opacity: fx.stars.opacity / 100,
        spin: fx.stars.spin,
      },
      links: {
        count: fx.links.count,
        speed: fx.links.speed,
        size: fx.links.size,
        opacity: fx.links.opacity / 100,
        link: fx.links.link,
        flow: fx.links.flow,
      },
      triangles: {
        count: fx.triangles.count,
        speed: fx.triangles.speed,
        size: fx.triangles.size,
        opacity: fx.triangles.opacity / 100,
        spin: fx.triangles.spin,
      },
      dust: {
        count: fx.dust.count,
        size: fx.dust.size,
        brightness: fx.dust.brightness / 100,
        speed: fx.dust.speed,
      },
    });
  }

  /** 内建星尘 / 播放光尘的颜色'''

sub(r"  // -{10} 背景粒子层：3D 空间内的星点 / 连线 / 三角（多选叠加） -{10}\n  function applyFxSetting\(\): void \{.*?\n  /\*\* 内建星尘 / 播放光尘的颜色", FX_APPLY, "fx-apply")

FX_SYNC = '''    fxBtns.forEach((button) => {
      button.classList.toggle('is-on', custom.fxModes.includes(button.dataset.fx ?? ''));
    });
    fxCurrent.textContent =
      custom.fxModes.length === 0 ? '关闭' : custom.fxModes.map((mode) => FX_LABEL[mode] ?? mode).join(' · ');
    syncFxPanels();
    fxInputs.forEach((input) => {
      const path = input.dataset.fxOpt ?? '';
      const spec = FX_UI[path];
      if (!spec) return;
      const value = fxValue(path);
      input.value = String(value);
      const label = root.querySelector<HTMLElement>('[data-fx-val="' + path + '"]');
      if (label) label.textContent = value.toFixed(spec.digits) + spec.unit;
    });'''

sub(r"    fxBtns\.forEach\(\(button\) => \{\n      button\.classList\.toggle\('is-on', custom\.fxModes\.includes\(button\.dataset\.fx \?\? ''\)\);\n    \}\);.*?    fxLinkInput\.value = String\(custom\.fxLink\);\n    fxLinkCurrent\.textContent = String\(custom\.fxLink\);", FX_SYNC, "fx-sync")

FX_HANDLERS = '''  fxBtns.forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.fx;
      if (value !== 'stars' && value !== 'links' && value !== 'triangles' && value !== 'dust') return;
      const next = new Set(custom.fxModes);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      custom.fxModes = [...next];
      syncCustomUi();
      applyFxSetting();
      persistCustom();
    });
  });
  // 每种粒子效果各自的滑条
  fxInputs.forEach((input) => {
    input.addEventListener('input', () => {
      const path = input.dataset.fxOpt ?? '';
      if (!FX_UI[path]) return;
      setFxValue(path, Number(input.value));
      applyFxSetting();
      persistCustom();
    });
  });
  // 内建星尘 / 播放光尘的颜色：紫 / 跟随封面色 / 自定义'''

sub(r"  fxBtns\.forEach\(\(button\) => \{\n    button\.addEventListener\('click', \(\) => \{\n      const value = button\.dataset\.fx;.*?  // 内建星尘 / 播放光尘的颜色：紫 / 跟随封面色 / 自定义", FX_HANDLERS, "fx-handlers")

print("OK:", ", ".join(ok))
