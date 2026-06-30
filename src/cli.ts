#!/usr/bin/env node

/**
 * wx2maple CLI — Markdown → 微信公众号 H5
 *
 * Usage:
 *   wx2maple <input.md> [output.html]       转换 Markdown → HTML 预览
 *   wx2maple publish <input.md> [options]   转换 + 推送微信草稿箱
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { convertToMapleH5 } from './converter.js';

const args = process.argv.slice(2);

// ── 帮助 ──────────────────────────────────────────────

function showHelp() {
  console.log(`
wx2maple - Convert Markdown to Maple-style WeChat H5

Usage:
  wx2maple <input.md> [output.html]         转换 Markdown 为 HTML 预览
  wx2maple publish <input.md> [options]     转换并推送至微信公众号草稿箱

Convert Options:
  <input.md>      输入的 Markdown 文件
  [output.html]   输出的 HTML 文件（默认: input_wx2maple.html）

Publish Options:
  <input.md>      输入的 Markdown 文件
  --config <path> config.json 路径（默认: 同目录 config.json）
  --cover  <path> 封面图本地路径
  --skip-images   跳过图片上传（图片 URL 已在线时使用）

Examples:
  wx2maple article.md                        生成 article_wx2maple.html
  wx2maple publish article.md                推送至草稿箱
  wx2maple publish article.md --cover cover.jpg --skip-images
`);
}

if (args.length === 0) {
  showHelp();
  process.exit(0);
}

// ── 子命令路由 ─────────────────────────────────────────

const subcommand = args[0];
if (subcommand === 'publish') {
  publishCommand(args.slice(1));
} else if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
  showHelp();
} else {
  convertCommand(args);
}

// ── convert 子命令 ────────────────────────────────────

function convertCommand(cmdArgs: string[]) {
  const inputFile = cmdArgs[0]!;
  const outputFile = cmdArgs[1] || inputFile.replace(/\.md$/, '_wx2maple.html');

  try {
    const markdown = readFileSync(inputFile, 'utf-8');
    const { html, sizeKB, warnings } = convertToMapleH5(markdown);

    const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maple AI Daily 预览</title>
</head>
<body style="margin: 0; padding: 20px; background-color: #f0f0f0;">
    <div class="rich_media_content js_underline_content autoTypeSetting24psection" style="margin-top: 0px;margin-bottom: 0px;margin-left: 0px;margin-right: 0px;padding-top: 20px;padding-bottom: 20px;padding-left: 0px;padding-right: 0px;background-color: rgb(250, 249, 245);width: auto;font-family: Optima, Microsoft YaHei, PingFangSC-regular, serif;font-size: 16px;color: rgb(0, 0, 0);line-height: 1.5em;word-spacing: 0em;letter-spacing: 0em;word-break: break-word;overflow-wrap: break-word;text-align: left;">
        ${html}
    </div>
</body>
</html>`;

    writeFileSync(outputFile, fullHtml);
    console.log(`✅ 转换完成: ${inputFile} -> ${outputFile}`);
    console.log(`📊 内容大小: ${sizeKB}KB`);

    if (sizeKB > 1024) {
      console.log(`⚠️  警告: 内容大小超过微信推送1MB限制！建议减少内容。`);
    }

    if (warnings.length > 0) {
      console.log(`\n⚠️  图片路径警告:`);
      warnings.forEach(w => console.log(`   - ${w}`));
    }

    console.log(`\n💡 API使用提示: 生成的HTML内容可直接用于微信公众号API的content字段`);

  } catch (error) {
    console.error('❌ 转换失败:', (error as Error).message);
    process.exit(1);
  }
}

// ── publish 子命令 ─────────────────────────────────────

async function publishCommand(cmdArgs: string[]) {
  const mdPath = cmdArgs.find(a => !a.startsWith('--') && a !== 'publish');
  if (!mdPath) {
    console.error('❌ 请指定 Markdown 文件路径');
    console.error('   wx2maple publish <input.md> [--config config.json] [--cover cover.jpg] [--skip-images]');
    process.exit(1);
  }

  // 解析选项
  let configPath: string | undefined;
  let coverPath: string | undefined;
  let skipImages = false;

  for (let i = 0; i < cmdArgs.length; i++) {
    if (cmdArgs[i] === '--config' && cmdArgs[i + 1]) {
      configPath = cmdArgs[i + 1]!;
      i++;
    } else if (cmdArgs[i] === '--cover' && cmdArgs[i + 1]) {
      coverPath = cmdArgs[i + 1]!;
      i++;
    } else if (cmdArgs[i] === '--skip-images') {
      skipImages = true;
    }
  }

  const { publishCli } = await import('./publish.js');
  await publishCli(mdPath, {
    ...(configPath ? { config: configPath } : {}),
    ...(coverPath ? { cover: coverPath } : {}),
    ...(skipImages ? { skipImages: true } : {}),
  });
}
