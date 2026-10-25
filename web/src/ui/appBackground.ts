/**
 * 整站背景（app-bg）模式与自定义图片的本地存储。
 *
 * 三种模式：
 *   - none ：不画整屏背景（纯页面底色）
 *   - cover：跟随当前歌曲封面，随切歌交叉淡入（历史行为，默认）
 *   - image：用户自定义图片，固定不随歌曲变化
 *
 * 自定义图片存 localStorage（data URL）：选图后用 canvas 缩到最长边 ≤1600px、
 * JPEG 0.82 压缩，通常几百 KB，不会撑爆 5MB 的 localStorage 配额。
 */

export type AppBgMode = 'none' | 'cover' | 'image';

const MODE_KEY = 'zilux2.appBgMode';
const IMAGE_KEY = 'zilux2.appBgImage';
/** 旧版本的开关：'0' = 关闭，其他 = 跟随封面（用于迁移）。 */
const LEGACY_KEY = 'zilux2.appCoverBg';

const IMAGE_MAX_EDGE = 1600;
const IMAGE_QUALITY = 0.82;

function parseMode(value: string | null): AppBgMode | null {
  return value === 'none' || value === 'cover' || value === 'image' ? value : null;
}

/** 读取背景模式；旧版本只有开/关两态，自动迁移成 cover/none。 */
export function readAppBgMode(): AppBgMode {
  try {
    const stored = parseMode(localStorage.getItem(MODE_KEY));
    if (stored) return stored;
    return localStorage.getItem(LEGACY_KEY) === '0' ? 'none' : 'cover';
  } catch {
    return 'cover';
  }
}

export function writeAppBgMode(mode: AppBgMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
    // 兼容旧代码路径：快捷设置仍可能读这个键。
    localStorage.setItem(LEGACY_KEY, mode === 'none' ? '0' : '1');
  } catch {
    /* 忽略隐私模式写入失败 */
  }
}

export function readAppBgImage(): string {
  try {
    return localStorage.getItem(IMAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeAppBgImage(dataUrl: string): void {
  try {
    if (dataUrl) localStorage.setItem(IMAGE_KEY, dataUrl);
    else localStorage.removeItem(IMAGE_KEY);
  } catch {
    /* 忽略隐私模式写入失败 */
  }
}

/**
 * 把用户选择的图片压成适合做背景的 data URL（最长边 1600px、JPEG 0.82）。
 * 失败时抛错，由调用方提示用户。
 */
export async function readBackgroundImageFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前环境无法处理图片');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', IMAGE_QUALITY);
}

/** 选图：打开系统文件选择器，返回压缩后的 data URL；用户取消返回 ''。 */
export function pickBackgroundImageFile(): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.append(input);
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) {
        resolve('');
        return;
      }
      readBackgroundImageFile(file).then(resolve, reject);
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve('');
    });
    input.click();
  });
}
