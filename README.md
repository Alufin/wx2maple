# wx2maple

将 Markdown 转换为 Maple AI 日报样式的微信 H5 推送内容，支持一键推送到微信公众号草稿箱。

## 快速开始

### 命令行使用

#### 本地预览
```bash
# 进入项目安装
npm install

npm run build

npm link
## 基础转换（生成 input_maple.html）
wx2maple input.md

## 指定输出文件名
wx2maple input.md output.html
```

#### 一键推送到微信公众号草稿箱
```bash
# 推送至草稿箱（使用默认 config.json）
wx2maple publish input.md --cover input.png
```

推送流程：
1. 获取微信 access_token（自动缓存）
2. 解析 Markdown 中的本地/外部图片 → 上传到微信图床 → 替换为 `mmbiz.qpic.cn` URL
3. 转换 Markdown 为 Maple H5 样式 HTML
4. 上传封面图（永久素材）
5. 调用 `draft/add` 接口推入草稿箱

#### 配置文件

推送功能需要在项目目录下准备 `config.json`：

```json
{
  "wechat": {
    "appId": "wxXXXXXXXXXXXXXXXX",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "tokenCacheFile": ".wechat-token.json"
  },
  "article": {
    "author": "作者名",
    "digest": "",
    "defaultThumbMediaId": "",
    "contentSourceUrl": "",
    "needOpenComment": 1,
    "onlyFansCanComment": 0
  }
}
```

| 字段 | 说明 |
|------|------|
| `wechat.appId` | 微信公众号 AppID |
| `wechat.appSecret` | 微信公众号 AppSecret |
| `wechat.tokenCacheFile` | access_token 缓存文件路径 |
| `article.author` | 推送作者名 |
| `article.digest` | 摘要（留空则自动从正文提取前 54 字） |
| `article.defaultThumbMediaId` | 默认封面 media_id（未指定 `--cover` 时使用） |
| `article.contentSourceUrl` | "阅读原文"链接 |
| `article.needOpenComment` | 是否打开评论（0/1） |
| `article.onlyFansCanComment` | 是否仅粉丝可评论（0/1） |

### 效果演示

<table>
<tr>
<td align="center" width="50%">
<img src="assets/example.png" alt="转换后的 H5 样式效果" width="400"/>
<br/>
</td>
</tr>
</table>

### 本地开发

```bash
npm install

npm run build

# 创建全局命令链接（用于本地测试）
npm link

# 现在可以全局使用 wx2maple 命令
# 或直接使用 node dist/cli.js example.md
wx2maple example.md

# 修改代码后重新构建即可（无需重新 link）
npm run build

# 开发完成后，取消全局链接
npm unlink
```
## 支持的 Markdown 语法

| 语法类型 | Markdown 语法 | 样式特征 | 特殊功能 |
|---------|-------------|----------|----------|
| **一级标题** | `# 标题` | 蓝色居中大字体 | 作为文档主标题，也用于提取推送标题 |
| **二级标题** | `## 标题 #1` | 米色背景 + 绿色底线 + 圆角 | 支持行内 `#1` 标签 |
| **三级标题** | `### 标题` | 橘色加粗 | 子章节标题 |
| **段落文本** | `普通文本` | 标准段落样式 | 支持内联代码、粗体 |
| **无序列表** | `- 列表项 #1` | 自动编号 + 橘色标签 | 支持行内 `#1` 标签 |
| **引用块** | `> 引用内容` | 米色背景 + 圆角边框 | 支持粗体、内联代码 |
| **代码块** | ` ```代码``` ` | 白色背景 + 灰色边框 + 圆角 | — |
| **内联代码** | `` `代码` `` | 米色背景 + 橘红色文字 | 上下文感知样式 |
| **粗体文本** | `**粗体**` | 加粗 | — |
| **链接** | `[文字](url)` | 黑色 + 下划线 | — |
| **图片** | `![alt](url)` | 圆角 + 居中容器 | 发布时自动上传到微信图床 |
| **分割线** | `---` | 虚线分隔 | 章节分割 |
| **表格** | `\| 列1 \| 列2 \|` | 奇偶行交替背景 + 边框 | 加粗表头 |

> **关于 `#1` 标签**：在二级标题或列表项末尾添加 `#1`、`#2` 等标记，会渲染为橘色代码风格的小标签。

## 项目结构

```
src/
├── styles.ts      # 样式配置 — 定义所有 HTML 元素的内联样式
├── converter.ts   # 核心转换逻辑 — 自定义 marked.js 渲染器
├── index.ts       # 包主入口 — 导出转换 API
├── cli.ts         # CLI 工具 — 命令行接口（转换 + 发布路由）
└── publish.ts     # 发布模块 — 图片上传 + 微信草稿箱推送
```
