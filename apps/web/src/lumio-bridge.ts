/**
 * LUMIO Bridge —— openreel 被嵌入到 LUMIO (iskutools.com) iframe 里时的桥接层。
 *
 * 协议:
 * - URL search params(LUMIO 跳转时拼)
 *   ?videos=url1,url2,...   逗号分隔的 mp4 URL,iframe 启动后自动 fetch + 加到 timeline
 *   ?theme=dark|light       UI 主题,直接设到 theme-store
 *   ?lang=zh|en             UI 语言(占位,真实 i18n 在阶段 4)
 *
 * - postMessage(双向)
 *   parent → iframe { type: 'lumio:set-theme', theme: 'dark'|'light' }
 *   iframe → parent { type: 'lumio:videos-loaded', count }
 *   iframe → parent { type: 'lumio:export-done', blob, mimeType, fileName }  // 阶段 5
 *   iframe → parent { type: 'lumio:bridge-error', message }
 *
 * 这个文件独立,不动 openreel 任何原有逻辑;上游 git pull 几乎不会冲突。
 */

import { useProjectStore } from './stores/project-store';
import { useThemeStore, type ThemeMode } from './stores/theme-store';

const TAG = '[lumio-bridge]';

/** 允许的父窗口 origin —— postMessage 鉴权用 */
const TRUSTED_ORIGINS = [
  'https://iskutools.com',
  'https://www.iskutools.com',
  'http://localhost:5173',
  'http://localhost:5174',
];

function isTrustedOrigin(origin: string): boolean {
  if (TRUSTED_ORIGINS.includes(origin)) return true;
  // 允许 iskutools.com 任意子域
  try {
    const u = new URL(origin);
    if (u.hostname.endsWith('.iskutools.com')) return true;
  } catch { /* ignore */ }
  return false;
}

/** postMessage 给父窗口,带 try/catch 防 iframe 脱嵌时报错 */
function notifyParent(payload: Record<string, unknown>): void {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(payload, '*');
    }
  } catch (e) {
    console.warn(TAG, 'postMessage failed', e);
  }
}

/** 从 URL ?videos= 拿 URL 数组(URL-decode + 过滤空) */
function parseVideosParam(): string[] {
  const raw = new URLSearchParams(window.location.search).get('videos');
  if (!raw) return [];
  return raw.split(',').map((s) => {
    try { return decodeURIComponent(s.trim()); } catch { return s.trim(); }
  }).filter(Boolean);
}

/** 把单个 URL fetch 成 File 对象,失败 throw */
async function urlToFile(url: string): Promise<File> {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const blob = await res.blob();
  const tail = (url.split('?')[0].split('/').pop() ?? 'video.mp4').slice(0, 80);
  return new File([blob], tail, { type: blob.type || 'video/mp4' });
}

/**
 * 自动从 LUMIO 传来的 ?videos= URL 加载视频:
 * 1. 创建新项目(给个像样的名字)
 * 2. 逐个 fetch → importMedia → addClipToNewTrack
 *    addClipToNewTrack 不传 startTime 时,openreel 自动接 timeline 尾部 ——
 *    所以多个视频会顺序排在 timeline 上,无需手动计算偏移。
 */
async function autoLoadVideos(urls: string[]): Promise<void> {
  if (urls.length === 0) return;

  const project = useProjectStore.getState();
  project.createNewProject('LUMIO Edit', {
    width: 1920,
    height: 1080,
    frameRate: 30,
  });

  // createNewProject 是同步 setState,但 actionExecutor 内部初始化可能异步 ——
  // 等一帧确保 store 完全就绪。
  await new Promise((resolve) => setTimeout(resolve, 100));

  let loaded = 0;
  let failed = 0;
  for (const url of urls) {
    try {
      const file = await urlToFile(url);
      const proj = useProjectStore.getState();
      const importRes = await proj.importMedia(file);
      if (!importRes.success || !importRes.actionId) {
        console.warn(TAG, 'importMedia failed', url, importRes.error);
        failed++;
        continue;
      }
      // actionId 在 importMedia 里就是 newMediaItem.id
      const mediaId = importRes.actionId;
      const addRes = await useProjectStore.getState().addClipToNewTrack(mediaId);
      if (!addRes.success) {
        console.warn(TAG, 'addClipToNewTrack failed', mediaId, addRes.error);
        failed++;
        continue;
      }
      loaded++;
    } catch (e) {
      console.warn(TAG, 'load failed', url, e);
      failed++;
    }
  }

  notifyParent({ type: 'lumio:videos-loaded', count: loaded, failed });
  console.log(TAG, `videos loaded: ${loaded}/${urls.length} (${failed} failed)`);
}

/** parent → iframe postMessage 监听(主题切换等) */
function installMessageListener(): void {
  window.addEventListener('message', (e) => {
    if (!isTrustedOrigin(e.origin)) return;
    const data = e.data;
    if (!data || typeof data !== 'object') return;
    switch (data.type) {
      case 'lumio:set-theme': {
        const t = data.theme;
        if (t === 'dark' || t === 'light' || t === 'auto') {
          useThemeStore.getState().setMode(t as ThemeMode);
        }
        break;
      }
      default:
        // 未知 type 静默忽略,后续协议扩展用
        break;
    }
  });
}

/**
 * 初始化桥接 —— 在 main.tsx createRoot 之前调一次。
 * - 立即应用 theme(避免闪烁)
 * - 注册 postMessage 监听
 * - window.onload 后自动加载 videos(此时 React 已 mount,stores 可用)
 */
export function initLumioBridge(): void {
  // 没在 iframe 里跑(本地直接打开 openreel)时仍可走默认流程,但 bridge 不主动干预。
  const inIframe = window.self !== window.top;
  const params = new URLSearchParams(window.location.search);
  const hasLumioParams = params.has('videos') || params.has('theme') || params.has('lang');

  if (!inIframe && !hasLumioParams) {
    // 直接打开 openreel(不是从 LUMIO 嵌入),不动任何东西
    return;
  }

  console.log(TAG, 'init', { inIframe, hasLumioParams });

  // 1. theme 立即应用(避免 dark→light 闪烁)
  const themeParam = params.get('theme');
  if (themeParam === 'dark' || themeParam === 'light' || themeParam === 'auto') {
    try {
      useThemeStore.getState().setMode(themeParam as ThemeMode);
    } catch (e) {
      // store 尚未 hydrate,稍后再试
      setTimeout(() => {
        useThemeStore.getState().setMode(themeParam as ThemeMode);
      }, 0);
    }
  }

  // 2. 注册父窗口消息监听(任何时候都接)
  installMessageListener();

  // 3. 等页面 load 完成后自动加载 videos
  //    用 load 而非 DOMContentLoaded —— openreel App.tsx 启动时 useRouter 解析 hash
  //    决定显示 welcome / editor,要在它走完一轮后再操作 store 才稳。
  const videos = parseVideosParam();
  if (videos.length > 0) {
    if (document.readyState === 'complete') {
      // 已经 loaded,等一帧让 React mount
      setTimeout(() => { void autoLoadVideos(videos); }, 0);
    } else {
      window.addEventListener('load', () => {
        // 再等 100ms 让 React 完成首渲染 + welcome 屏初始化
        setTimeout(() => { void autoLoadVideos(videos); }, 100);
      }, { once: true });
    }
  }
}
