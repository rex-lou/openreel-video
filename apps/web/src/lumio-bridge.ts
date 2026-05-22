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

/** 从 URL ?media= (推荐) 或 ?videos= (向后兼容) 拿 URL 数组 */
function parseMediaParam(): string[] {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('media') ?? params.get('videos');
  if (!raw) return [];
  return raw.split(',').map((s) => {
    try { return decodeURIComponent(s.trim()); } catch { return s.trim(); }
  }).filter(Boolean);
}

const EXT_MIME: Record<string, string> = {
  // 视频
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4',
  // 图片
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  // 音频
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
};

/** 根据 URL 扩展名 + fetch blob.type 推断 MIME,fallback video/mp4 */
function inferMime(url: string, blobType: string): string {
  if (blobType && blobType !== 'application/octet-stream') return blobType;
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? 'video/mp4';
}

/** 把单个 URL fetch 成 File 对象,失败 throw */
async function urlToFile(url: string): Promise<File> {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const blob = await res.blob();
  const mime = inferMime(url, blob.type);
  const tailFromUrl = url.split('?')[0].split('/').pop() ?? '';
  const hasExt = /\.[a-z0-9]{1,5}$/i.test(tailFromUrl);
  const ext = mime.split('/')[1]?.replace('jpeg', 'jpg').replace('quicktime', 'mov') ?? 'mp4';
  const tail = (hasExt ? tailFromUrl : `${tailFromUrl || 'media'}.${ext}`).slice(0, 80);
  return new File([blob], tail, { type: mime });
}

/**
 * 把一批 URL(video / image / audio 混合)加进 timeline:
 * - 同类型连续的 media 共享一条 track(addClip 串联),累加 startTime
 * - 类型切换时(video → image)自动新建一条 track(addClipToNewTrack)
 * - image 在 store 里 metadata.duration 通常是 0,用 default IMAGE_DEFAULT_DUR 占时长
 */
const IMAGE_DEFAULT_DUR = 5;  // 静态图在 timeline 上默认占 5 秒

interface LoadCtx {
  videoTrackId: string | null;
  videoAcc: number;
  imageTrackId: string | null;
  imageAcc: number;
}

async function addOneMedia(url: string, ctx: LoadCtx): Promise<boolean> {
  const file = await urlToFile(url);
  const proj = useProjectStore.getState();
  const importRes = await proj.importMedia(file);
  if (!importRes.success || !importRes.actionId) {
    console.warn(TAG, 'importMedia failed', url, importRes.error);
    return false;
  }
  const mediaId = importRes.actionId;
  const mediaItem = useProjectStore.getState().getMediaItem(mediaId);
  if (!mediaItem) return false;

  const isImage = mediaItem.type === 'image';
  const duration = isImage ? IMAGE_DEFAULT_DUR : (mediaItem.metadata.duration ?? 0);
  const existingTrackId = isImage ? ctx.imageTrackId : ctx.videoTrackId;
  const acc = isImage ? ctx.imageAcc : ctx.videoAcc;

  if (existingTrackId === null) {
    const r = await proj.addClipToNewTrack(mediaId, 0);
    if (!r.success) {
      console.warn(TAG, 'addClipToNewTrack failed', mediaId, r.error);
      return false;
    }
    const tracks = useProjectStore.getState().project.timeline.tracks;
    const created = [...tracks].reverse().find(
      (t) => t.type === mediaItem.type && t.clips.some((c) => c.mediaId === mediaId),
    );
    const trackId = created?.id ?? null;
    if (isImage) ctx.imageTrackId = trackId;
    else ctx.videoTrackId = trackId;
  } else {
    const r = await useProjectStore.getState().addClip(existingTrackId, mediaId, acc);
    if (!r.success) {
      console.warn(TAG, 'addClip failed', mediaId, r.error);
      return false;
    }
  }
  if (isImage) ctx.imageAcc += duration;
  else ctx.videoAcc += duration;
  return true;
}

/**
 * 初始加载(URL ?media= 传入)—— 必须先 createNewProject。
 * 跳过 welcome 屏防 useEffect 重置我们的 project。
 */
async function autoLoadMedia(urls: string[]): Promise<void> {
  if (urls.length === 0) return;

  if (window.location.hash !== '#/editor' && window.location.hash !== '#/editor/') {
    window.location.hash = '#/editor';
  }
  await new Promise((resolve) => setTimeout(resolve, 200));

  const project = useProjectStore.getState();
  project.createNewProject('LUMIO Edit', { width: 1920, height: 1080, frameRate: 30 });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const ctx: LoadCtx = { videoTrackId: null, videoAcc: 0, imageTrackId: null, imageAcc: 0 };
  let loaded = 0;
  let failed = 0;
  for (const url of urls) {
    try {
      if (await addOneMedia(url, ctx)) loaded++;
      else failed++;
    } catch (e) {
      console.warn(TAG, 'load failed', url, e);
      failed++;
    }
  }
  notifyParent({ type: 'lumio:media-loaded', count: loaded, failed });
  console.log(TAG, `media loaded: ${loaded}/${urls.length} (${failed} failed)`);
}

/**
 * 增量加载(LUMIO postMessage 推送)—— 项目已经存在,继续往现有 track 加。
 * 复用 LoadCtx 让 video / image 各自的串联状态延续(每次新调用都重新扫一次现有 timeline
 * 确定 trackId / acc,这样支持用户在 LUMIO 多次 picker 加视频)。
 */
async function appendMedia(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const tracks = useProjectStore.getState().project?.timeline?.tracks ?? [];
  // 找现有最新的 video / image track + 它们的当前总长(用于新 clip 的 startTime)
  const calcAcc = (t: { clips: { startTime: number; duration: number }[] }) =>
    t.clips.reduce((m, c) => Math.max(m, c.startTime + c.duration), 0);
  const lastVideoTrack = [...tracks].reverse().find((t) => t.type === 'video');
  const lastImageTrack = [...tracks].reverse().find((t) => t.type === 'image');
  const ctx: LoadCtx = {
    videoTrackId: lastVideoTrack?.id ?? null,
    videoAcc: lastVideoTrack ? calcAcc(lastVideoTrack) : 0,
    imageTrackId: lastImageTrack?.id ?? null,
    imageAcc: lastImageTrack ? calcAcc(lastImageTrack) : 0,
  };
  let loaded = 0;
  let failed = 0;
  for (const url of urls) {
    try {
      if (await addOneMedia(url, ctx)) loaded++;
      else failed++;
    } catch (e) {
      console.warn(TAG, 'append failed', url, e);
      failed++;
    }
  }
  notifyParent({ type: 'lumio:media-appended', count: loaded, failed });
  console.log(TAG, `media appended: ${loaded}/${urls.length} (${failed} failed)`);
}

/**
 * 由 Toolbar.tsx 的 triggerDownload 调:把导出生成的 blob 通过 postMessage
 * 传给 LUMIO 父窗口,绕过 iframe 内的 <a download> 触发(跨源 iframe download 体验差)。
 * - 返回 true:已劫持,调用方不要再走本地下载
 * - 返回 false:不在 LUMIO 模式 / parent 缺失,调用方继续走本地下载
 *
 * blob 通过 structured clone 跨 frame 传(Blob 是 transferable structured-cloneable),
 * LUMIO 那侧 message handler 收到后立刻 fetch blob → 上传 R2 → 写 assets 表。
 */
let isLumioMode = false;
export function handleLumioExport(blob: Blob, fileName: string, mimeType: string): boolean {
  if (!isLumioMode || !window.parent || window.parent === window) return false;
  try {
    window.parent.postMessage(
      { type: 'lumio:export-done', blob, fileName, mimeType, size: blob.size },
      '*',
    );
    console.log(TAG, `export blob postMessage'd to parent: ${fileName} (${(blob.size/1024/1024).toFixed(2)} MB)`);
    return true;
  } catch (e) {
    console.warn(TAG, 'export postMessage failed', e);
    notifyParent({ type: 'lumio:bridge-error', message: `export forward failed: ${(e as Error).message}` });
    return false;
  }
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
      case 'lumio:add-media': {
        // LUMIO picker 选完资产后推过来,增量加到当前 timeline
        const urls = Array.isArray(data.urls) ? data.urls.filter((u: unknown): u is string => typeof u === 'string') : [];
        if (urls.length > 0) void appendMedia(urls);
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

  isLumioMode = true;
  console.log(TAG, 'init', { inIframe, hasLumioParams });

  // 0. 拔掉 window.showSaveFilePicker —— 跨源 iframe 里调用它会 throw NotAllowedError,
  //    让 Toolbar.tsx 的 `if ("showSaveFilePicker" in window)` 检测失败,自动走
  //    in-memory writable fallback,最后 triggerDownload 时调 handleLumioExport
  //    把 blob 转发给父窗口。
  try { delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker; } catch { /* ignore */ }

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
  const initial = parseMediaParam();
  if (initial.length > 0) {
    if (document.readyState === 'complete') {
      // 已经 loaded,等一帧让 React mount
      setTimeout(() => { void autoLoadMedia(initial); }, 0);
    } else {
      window.addEventListener('load', () => {
        // 再等 100ms 让 React 完成首渲染 + welcome 屏初始化
        setTimeout(() => { void autoLoadMedia(initial); }, 100);
      }, { once: true });
    }
  }
}
