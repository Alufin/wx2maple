/**
 * wx2maple publish — 一键将 Markdown 推送到微信公众号草稿箱
 *
 * 流程：
 *   1. 获取 access_token（带缓存）
 *   2. 解析 md 中的本地图片 → 上传到微信图文 → 替换为 mmbiz.qpic.cn URL
 *   3. convertToMapleH5() 转换为 HTML
 *   4. 上传封面图（永久素材）→ 获取 thumb_media_id
 *   5. 调用 draft/add 推入草稿箱
 */

import { readFileSync } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { basename, extname, dirname } from 'node:path';
import fetch from 'node-fetch';
import FormData from 'form-data';
import sharp from 'sharp';
import { convertToMapleH5 } from './converter.js';

// ── 类型 ──────────────────────────────────────────────

interface WechatConfig {
  wechat: {
    appId: string;
    appSecret: string;
    tokenCacheFile: string;
  };
  article: {
    author: string;
    digest: string;
    defaultThumbMediaId: string;
    contentSourceUrl: string;
    needOpenComment: number;
    onlyFansCanComment: number;
  };
}

interface TokenCache {
  access_token: string;
  expires_at: number; // unix ms
}

interface ImageUploadResult {
  url: string;
}

interface MaterialUploadResult {
  media_id: string;
  url?: string;
}

interface DraftResult {
  media_id: string;
}

// ── 工具 ──────────────────────────────────────────────

function log(msg: string) {
  process.stderr.write(`[wx2maple] ${msg}\n`);
}

function readConfig(path: string): WechatConfig {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// ── access_token ─────────────────────────────────────

async function getAccessToken(config: WechatConfig, configDir: string): Promise<string> {
  const cachePath = config.wechat.tokenCacheFile.startsWith('/')
    ? config.wechat.tokenCacheFile
    : `${configDir}/${config.wechat.tokenCacheFile}`;

  // 尝试读缓存
  try {
    const raw = readFileSync(cachePath, 'utf-8');
    const cache: TokenCache = JSON.parse(raw);
    if (cache.access_token && cache.expires_at > Date.now() + 300_000) {
      log('♻️  使用缓存的 access_token');
      return cache.access_token;
    }
  } catch {
    // 无缓存，重新获取
  }

  // 请求新 token
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${config.wechat.appId}&secret=${config.wechat.appSecret}`;
  log('🔑 获取 access_token ...');
  const res = await fetch(url);
  const data = await res.json() as any;

  if (data.errcode) {
    throw new Error(`获取 access_token 失败: ${data.errmsg} (errcode=${data.errcode})`);
  }

  const cache: TokenCache = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in - 300) * 1000,
  };

  // Node 内置 fs 写文件
  const { writeFileSync } = await import('node:fs');
  writeFileSync(cachePath, JSON.stringify(cache), 'utf-8');
  log(`✅ access_token 已缓存 (${data.expires_in}s 有效)`);
  return data.access_token;
}

// ── 图片上传（图文消息内图片） ────────────────────────

function mimeFromExt(filePath: string): string {
  return extname(filePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
}

async function uploadArticleImageBuffer(
  accessToken: string,
  buffer: Buffer,
  filename: string,
): Promise<string> {
  // webp → png 转码（微信只接受 jpg/png）
  const ext = extname(filename).toLowerCase();
  let uploadBuffer = buffer;
  let uploadName = filename;
  if (ext === '.webp') {
    log(`   🔄 转换 webp → png ...`);
    uploadBuffer = await sharp(buffer).png().toBuffer();
    uploadName = basename(filename, ext) + '.png';
    log(`   ✅ ${filename} (${(buffer.length / 1024).toFixed(1)}KB) → ${uploadName} (${(uploadBuffer.length / 1024).toFixed(1)}KB)`);
  }

  const mime = mimeFromExt(uploadName);
  const form = new FormData();
  form.append('media', uploadBuffer, {
    filename: uploadName,
    contentType: mime,
    knownLength: uploadBuffer.length,
  });

  const url = `https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=${accessToken}`;
  const res = await fetch(url, { method: 'POST', body: form as any });
  const data = await res.json() as any;

  if (data.errcode) {
    throw new Error(`上传图片失败: ${data.errmsg} (errcode=${data.errcode})`);
  }

  return data.url;
}

async function uploadArticleImage(
  accessToken: string,
  filePath: string,
): Promise<string> {
  log(`🖼️  上传图文图片: ${basename(filePath)}`);
  const buffer = await readFile(filePath);
  const wxUrl = await uploadArticleImageBuffer(accessToken, buffer, basename(filePath));
  log(`   ✅ ${wxUrl}`);
  return wxUrl;
}

// ── 下载外部图片并重新上传到微信图床 ──────────────────

function isWechatImageUrl(url: string): boolean {
  return url.includes('mmbiz.qpic.cn') || url.includes('mmbiz.qlogo.cn');
}

function isExternalImageUrl(url: string): boolean {
  return (url.startsWith('http://') || url.startsWith('https://')) && !isWechatImageUrl(url);
}

async function downloadAndReuploadImage(
  accessToken: string,
  imageUrl: string,
): Promise<string> {
  log(`⬇️  下载外部图片: ${imageUrl.substring(0, 60)}...`);

  const res = await fetch(imageUrl);
  if (!res.ok) {
    throw new Error(`下载图片失败: HTTP ${res.status} ${imageUrl}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  // 从 URL 或 Content-Type 推断文件名
  const urlPath = new URL(imageUrl).pathname;
  let filename = basename(urlPath) || 'image.jpg';
  if (!extname(filename)) {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('png')) filename += '.png';
    else if (ct.includes('webp')) filename += '.png'; // webp 会由 uploadArticleImageBuffer 自动转码
    else filename += '.jpg';
  }

  log(`🖼️  重新上传到微信图床: ${filename} (${(buffer.length / 1024).toFixed(1)}KB)`);
  const wxUrl = await uploadArticleImageBuffer(accessToken, buffer, filename);
  log(`   ✅ ${wxUrl}`);
  return wxUrl;
}

// ── 上传永久素材（封面图） ─────────────────────────────

async function uploadPermanentImage(
  accessToken: string,
  filePath: string,
): Promise<MaterialUploadResult> {
  log(`🎨 上传封面图: ${basename(filePath)}`);

  const fileBuffer = await readFile(filePath);
  const ext = extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
  };
  const mime = mimeMap[ext] || 'image/jpeg';

  const form = new FormData();
  form.append('media', fileBuffer, {
    filename: basename(filePath),
    contentType: mime,
    knownLength: fileBuffer.length,
  });

  const url = `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${accessToken}&type=image`;
  const res = await fetch(url, { method: 'POST', body: form as any });
  const data = await res.json() as any;

  if (data.errcode) {
    throw new Error(`上传封面失败: ${data.errmsg} (errcode=${data.errcode})`);
  }

  log(`   ✅ media_id=${data.media_id}`);
  return { media_id: data.media_id, url: data.url };
}

// ── 解析 md 中的图片 ──────────────────────────────────

function extractImages(markdown: string): Array<{ alt: string; path: string; fullMatch: string }> {
  const imgs: Array<{ alt: string; path: string; fullMatch: string }> = [];
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    imgs.push({ alt: m[1] || '', path: m[2] || '', fullMatch: m[0] });
  }
  return imgs;
}

function isLocalPath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~') || path.startsWith('./') || path.startsWith('../') ||
    (!path.startsWith('http://') && !path.startsWith('https://'));
}

function isRemoteUrl(path: string): boolean {
  return path.startsWith('http://') || path.startsWith('https://') || path.startsWith('//');
}

// ── 提取标题 ──────────────────────────────────────────

function extractTitle(markdown: string): string {
  // 匹配第一个 # 标题
  const m = markdown.match(/^#\s+(.+)$/m);
  if (m && m[1]) {
    return m[1].trim().substring(0, 64);
  }
  // fallback: 文件名
  return '未命名文章';
}

// ── 计算摘要 ──────────────────────────────────────────

function extractDigest(markdown: string, config: WechatConfig): string {
  if (config.article.digest) return config.article.digest;
  // 取正文前 54 个字（去除 markdown 标记）
  const plain = markdown
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/[#*>`|~\-_\[\]]/g, '')
    .replace(/\n+/g, ' ')
    .trim();
  return plain.substring(0, 54);
}

// ── 主流程 ────────────────────────────────────────────

export interface PublishOptions {
  /** markdown 文件路径 */
  mdPath: string;
  /** config.json 路径，默认同目录下的 config.json */
  configPath?: string;
  /** 封面图路径，不填则用第一张图片 */
  coverPath?: string;
  /** 是否跳过图片上传（图片已在线上） */
  skipImageUpload?: boolean;
}

export interface PublishResult {
  /** 草稿 media_id */
  draftMediaId: string;
  /** 转换后的 HTML */
  html: string;
  /** HTML 大小 KB */
  sizeKB: number;
  /** 标题 */
  title: string;
  /** 摘要 */
  digest: string;
  /** 上传的图片数量 */
  imagesUploaded: number;
}

export async function publishToWechat(options: PublishOptions): Promise<PublishResult> {
  const configPath = options.configPath || new URL('../config.json', import.meta.url).pathname;
  const config = readConfig(configPath);
  const configDir = dirname(configPath);

  // ── 1. 获取 access_token ──
  const accessToken = await getAccessToken(config, configDir);

  // ── 2. 读取 markdown ──
  let markdown = readFileSync(options.mdPath, 'utf-8');
  log(`📄 读取文件: ${basename(options.mdPath)} (${markdown.length} 字符)`);

  // ── 3. 提取标题、摘要 ──
  const title = extractTitle(markdown);
  const digest = extractDigest(markdown, config);
  log(`📝 标题: ${title}`);

  // ── 4. 上传图片 ──
  let imagesUploaded = 0;
  if (!options.skipImageUpload) {
    const images = extractImages(markdown);

    for (const img of images) {
      if (isExternalImageUrl(img.path)) {
        // 外部 URL（非微信 CDN）→ 下载后重新上传到微信图床
        try {
          const wxUrl = await downloadAndReuploadImage(accessToken, img.path);
          markdown = markdown.replace(img.fullMatch, img.fullMatch.replace(img.path, wxUrl));
          imagesUploaded++;
        } catch (err: any) {
          log(`⚠️  外部图片处理失败: ${err.message}`);
        }
      } else if (isWechatImageUrl(img.path)) {
        // 已经是微信 CDN 图片，跳过
        log(`⏭️  已是微信图片，跳过: ${img.path.substring(0, 50)}...`);
      } else if (isLocalPath(img.path)) {
        // 解析路径（相对于 md 文件目录）
        const { resolve, dirname } = await import('node:path');
        const mdDir = dirname(resolve(options.mdPath));
        let imgPath = img.path;
        if (imgPath.startsWith('~')) {
          const { homedir } = await import('node:os');
          imgPath = homedir() + imgPath.slice(1);
        }
        if (!imgPath.startsWith('/')) {
          imgPath = resolve(mdDir, imgPath);
        }

        // 检查文件是否存在
        try {
          await stat(imgPath);
        } catch {
          log(`⚠️  图片不存在，跳过: ${imgPath}`);
          continue;
        }

        const wxUrl = await uploadArticleImage(accessToken, imgPath);
        // 替换 markdown 中的图片链接
        markdown = markdown.replace(img.fullMatch, img.fullMatch.replace(img.path, wxUrl));
        imagesUploaded++;
      }
    }
  }

  if (imagesUploaded === 0 && !options.skipImageUpload) {
    log('ℹ️  没有发现本地图片，跳过上传');
  }

  // ── 5. 转换 Markdown → HTML ──
  const { html: bodyHtml, sizeKB, warnings } = convertToMapleH5(markdown);

  // 打印警告
  for (const w of warnings) {
    log(`⚠️  ${w}`);
  }

  log(`📊 HTML 大小: ${sizeKB}KB`);

  // ── 6. 处理封面图 ──
  let thumbMediaId = config.article.defaultThumbMediaId;

  if (options.coverPath) {
    const result = await uploadPermanentImage(accessToken, options.coverPath);
    thumbMediaId = result.media_id;
  } else if (!thumbMediaId) {
    // 尝试用文章第一张图片做封面
    const images = extractImages(markdown);
    const firstImg = images[0];
    if (firstImg && isRemoteUrl(firstImg.path)) {
      // 远程 URL 需要先下载再上传为永久素材
      log('⚠️  封面图为远程 URL，需要先下载再上传。请使用 --cover 指定本地封面图');
      log('   跳过封面，使用默认封面（如有）');
    }
  }

  if (!thumbMediaId) {
    log('⚠️  未设置封面图，草稿将没有封面。可在 config.json 中设置 defaultThumbMediaId');
  }

  // ── 7. 推入草稿箱 ──
  log('📤 推入草稿箱 ...');

  const article: Record<string, any> = {
    article_type: 'news',
    title,
    content: bodyHtml,
  };

  if (config.article.author) article.author = config.article.author;
  if (digest) article.digest = digest;
  if (thumbMediaId) article.thumb_media_id = thumbMediaId;
  if (config.article.contentSourceUrl) article.content_source_url = config.article.contentSourceUrl;
  if (config.article.needOpenComment !== undefined) article.need_open_comment = config.article.needOpenComment;
  if (config.article.onlyFansCanComment !== undefined) article.only_fans_can_comment = config.article.onlyFansCanComment;

  const draftUrl = `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${accessToken}`;
  const draftRes = await fetch(draftUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ articles: [article] }),
  });
  const draftData = await draftRes.json() as any;

  if (draftData.errcode) {
    throw new Error(`创建草稿失败: ${draftData.errmsg} (errcode=${draftData.errcode})`);
  }

  log(`✅ 草稿创建成功! media_id: ${draftData.media_id}`);

  return {
    draftMediaId: draftData.media_id,
    html: bodyHtml,
    sizeKB,
    title,
    digest,
    imagesUploaded,
  };
}

// ── CLI 入口（从 cli.ts 调用） ─────────────────────────

export async function publishCli(mdPath: string, options: {
  config?: string;
  cover?: string;
  skipImages?: boolean;
}) {
  try {
    const result = await publishToWechat({
      mdPath,
      ...(options.config ? { configPath: options.config } : {}),
      ...(options.cover ? { coverPath: options.cover } : {}),
      ...(options.skipImages ? { skipImageUpload: true } : {}),
    });

    console.log(JSON.stringify({
      success: true,
      media_id: result.draftMediaId,
      title: result.title,
      sizeKB: result.sizeKB,
      imagesUploaded: result.imagesUploaded,
    }, null, 2));
    process.exit(0);
  } catch (err: any) {
    console.error(JSON.stringify({
      success: false,
      error: err.message,
    }, null, 2));
    process.exit(1);
  }
}
