import { marked } from 'marked';
import { MapleStyles } from './styles.js';

/**
 * 配置自定义 tokenizer，修复中文符号作为边界的加粗问题
 * 基于 marked.js 16.2.1 的修改方案 - 扩展标点符号检查以兼容中文符号
 */
function setupChineseBoldFix() {
  marked.use({
    tokenizer: {
      emStrong(src: string, maskedSrc: string, prevChar = '') {
        // 优化的星号匹配：只处理简单的双星号，避免与三星号冲突
        // 只在开头是两个星号且第三个字符不是星号时匹配
        if (src.startsWith('**') && src[2] !== '*') {
          const strongMatch = src.match(/^\*\*([\s\S]+?)\*\*/);
          if (strongMatch && strongMatch[1]) {
            const text = strongMatch[1];
            return {
              type: 'strong',
              raw: strongMatch[0],
              text,
              tokens: this.lexer.inlineTokens(text),
            };
          }
        }

        // 优化的单星号匹配：只在开头是单星号且第二个字符不是星号时匹配  
        if (src.startsWith('*') && src[1] !== '*') {
          const emMatch = src.match(/^\*([\s\S]+?)\*/);
          if (emMatch && emMatch[1]) {
            const text = emMatch[1];
            return {
              type: 'em',
              raw: emMatch[0],
              text,
              tokens: this.lexer.inlineTokens(text),
            };
          }
        }

        // 如果没有匹配到，fallback到原始逻辑
        let match = this.rules.inline.emStrongLDelim.exec(src);
        if (!match) return;

        // _ can't be between two alphanumerics. \p{L}\p{N} includes non-english alphabet/numbers as well
        if (match[3] && prevChar.match(this.rules.other.unicodeAlphaNumeric)) return;

        const nextChar = match[1] || match[2] || '';

        if (!nextChar || !prevChar || this.rules.inline.punctuation.exec(prevChar)) {
          // 原始的完整逻辑作为fallback
          const lLength = [...match[0]].length - 1;
          let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;

          const endReg = match[0][0] === '*' ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
          endReg.lastIndex = 0;

          maskedSrc = maskedSrc.slice(-1 * src.length + lLength);

          while ((match = endReg.exec(maskedSrc)) != null) {
            rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];

            if (!rDelim) continue;

            rLength = [...rDelim].length;

            if (match[3] || match[4]) {
              delimTotal += rLength;
              continue;
            } else if (match[5] || match[6]) {
              if (lLength % 3 && !((lLength + rLength) % 3)) {
                midDelimTotal += rLength;
                continue;
              }
            }

            delimTotal -= rLength;

            if (delimTotal > 0) continue;

            rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
            const matchChars = [...match[0]];
            const lastCharLength = matchChars.length > 0 && matchChars[0] ? matchChars[0].length : 1;
            const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

            if (Math.min(lLength, rLength) % 2) {
              const text = raw.slice(1, -1);
              return {
                type: 'em',
                raw,
                text,
                tokens: this.lexer.inlineTokens(text),
              };
            }

            const text = raw.slice(2, -2);
            return {
              type: 'strong',
              raw,
              text,
              tokens: this.lexer.inlineTokens(text),
            };
          }
        }
      },
    }
  });
}

/**
 * Maple AI日报H5版式制作器
 * 直接的数据驱动渲染，无复杂抽象层
 */
export class MapleH5Maker {
  private inlineContext: 'default' | 'plain' = 'default';
  
  constructor() {
    setupChineseBoldFix(); // 首先配置中文加粗修复
    this.setupMarkedRenderer();
  }

  /**
   * 配置marked渲染器，直接映射到微信样式
   */
  private setupMarkedRenderer(): void {
    const renderer = new marked.Renderer();
    
    // H1标题渲染
    renderer.heading = ({ tokens, depth }: any) => {
      const text = this.withInlineContext('default', () => this.parseTokens(tokens));
      if (depth === 1) {
        return `<h1 style="${MapleStyles.h1.style}">
          <span style="display: none;"></span>
          <span style="${MapleStyles.h1.span}">${text}</span>
          <span style="display: none;"></span>
        </h1>`;
      }
      
      if (depth === 2) {
        return `<h2 style="${MapleStyles.h2.style}">
          <span style="display: none;"></span>
          <span style="${MapleStyles.h2.span}">${text}</span>
          <span style="display: none;"></span>
        </h2>`;
      }
      
      if (depth === 3) {
        return `<h3 style="${MapleStyles.h3.style}">
          <span style="${MapleStyles.h3.span}">${text}</span>
        </h3>`;
      }
      
      return `<h${depth}>${text}</h${depth}>`;
    };

    // 段落渲染
    renderer.paragraph = ({ tokens }: any) => {
      if (tokens && tokens.length === 1 && tokens[0].type === 'image') {
        return this.renderImage(tokens[0]);
      }
      const text = this.withInlineContext('plain', () => this.parseTokens(tokens));
      return `<p style="${MapleStyles.p.style}">${text}</p>`;
    };

    // 列表渲染
    renderer.list = ({ items }: any) => {
      const body = items.map((item: any) => this.renderListItem(item)).join('');
      return `<ul class="${MapleStyles.ul.className}" style="${MapleStyles.ul.style}">${body}</ul>`;
    };

    // 引用块渲染
    renderer.blockquote = ({ tokens }: any) => {
      // 遍历块级 tokens，区分段落、列表、代码块等
      const content = tokens.map((token: any) => {
        if (token.type === 'paragraph') {
          const text = this.withInlineContext('plain', () => this.parseTokens(token.tokens || []));
          return `<p style="${MapleStyles.blockquote.p}">${text}</p>`;
        }
        if (token.type === 'list') {
          const body = (token.items || []).map((item: any) => this.renderListItem(item)).join('');
          return `<ul class="${MapleStyles.ul.className}" style="${MapleStyles.ul.style}">${body}</ul>`;
        }
        if (token.type === 'code') {
          return `<pre style="${MapleStyles.pre.style}"><code style="${MapleStyles.pre.code}"><span leaf="">${this.escapeHtml(token.text || '')}</span></code></pre>`;
        }
        if (token.type === 'hr') {
          return `<hr style="${MapleStyles.hr.style}" />`;
        }
        // fallback: 用 raw text 做 inline 解析
        const rawText = token.raw || token.text || '';
        return this.withInlineContext('plain', () => marked.parseInline(rawText) as string);
      }).join('\n');
      
      return `<blockquote style="${MapleStyles.blockquote.style}">${content}</blockquote>`;
    };

    // 代码块渲染
    renderer.code = ({ text }: any) => {
      return `<pre style="${MapleStyles.pre.style}"><code style="${MapleStyles.pre.code}"><span leaf="">${this.escapeHtml(text)}</span></code></pre>`;
    };

    // 内联代码渲染
    renderer.codespan = ({ text }: any) => {
      return this.renderInlineCode({ text });
    };

    // 图片渲染
    renderer.image = ({ href, title, text }: any) => {
      return `<figure style="${MapleStyles.figure.style}">
        <img style="${MapleStyles.figure.img}" src="${href}" alt="${text}" ${title ? `title="${title}"` : ''} />
      </figure>`;
    };

    // 水平分割线渲染
    renderer.hr = () => {
      return `<hr style="${MapleStyles.hr.style}" />`;
    };

    // 强调文本渲染
    renderer.strong = ({ tokens }: any) => {
      const text = this.parseTokens(tokens);
      return `<strong style="${MapleStyles.strong.style}">${text}</strong>`;
    };

    // 链接渲染
    renderer.link = ({ href, tokens }: any) => {
      const text = this.parseTokens(tokens);
      return `<a style="${MapleStyles.link.style}" href="${href}">${text}</a>`;
    };

               // 表格渲染
           renderer.table = ({ header, rows }: any) => {
             const headerRow = this.renderTableHeader(header);
             const bodyRows = rows.map((row: any, index: number) => this.renderTableRow(row, index)).join('');
             
             return `<section data-tool="mdnice编辑器" style="${MapleStyles.tableContainer.style}">
               <table style="${MapleStyles.table.style}">
                 <thead>
                   ${headerRow}
                 </thead>
                 ${bodyRows}
               </table>
             </section>`;
           };

    marked.setOptions({ renderer, breaks: true });
  }

  /**
   * 解析tokens为文本
   */
  private parseTokens(tokens: any[]): string {
    return tokens.map((token: any) => {
      if (token.type === 'image') {
        return this.renderImage(token);
      }
      if (token.type === 'codespan') {
        return this.renderInlineCode(token);
      }
      if (token.type === 'strong') {
        return this.renderStrong(token);
      }
      if (token.type === 'link') {
        return this.renderLink(token);
      }
      if (token.type === 'br') {
        return '<br />';
      }
      if (token.type === 'text') {
        if (token.tokens && token.tokens.length) {
          return this.parseTokens(token.tokens);
        }
        return token.raw || token.text || '';
      }
      if (token.type === 'html') {
        return token.raw || token.text || '';
      }
      if (token.type === 'paragraph') {
        if (token.tokens && token.tokens.length === 1 && token.tokens[0].type === 'image') {
          return this.renderImage(token.tokens[0]);
        }
        return this.withInlineContext('plain', () => this.parseTokens(token.tokens || []));
      }
      return marked.parseInline(token.raw || token.text || '') as string;
    }).join('');
  }

  /**
   * 渲染图片token
   */
  private renderImage(token: any): string {
    if (token.type === 'paragraph') {
      const imageToken = (token.tokens || []).find((t: any) => t.type === 'image');
      if (imageToken) {
        return this.renderImage(imageToken);
      }
    }
    return `<figure style="${MapleStyles.figure.style}">
      <img style="${MapleStyles.figure.img}" src="${token.href}" alt="${token.text}" ${token.title ? `title="${token.title}"` : ''} />
    </figure>`;
  }

  /**
   * 渲染内联代码token
   */
  private renderInlineCode(token: any): string {
    const style = this.inlineContext === 'plain'
      ? MapleStyles.inlineCodePlain.style
      : MapleStyles.inlineCode.style;
    return `<code style="${style}">${this.escapeHtml(token.text)}</code>`;
  }

  /**
   * 渲染强调文本token
   */
  private renderStrong(token: any): string {
    const text = token.tokens ? this.parseTokens(token.tokens) : token.text;
    return `<strong style="${MapleStyles.strong.style}">${text}</strong>`;
  }

  /**
   * 渲染链接token
   */
  private renderLink(token: any): string {
    const text = token.tokens ? this.parseTokens(token.tokens) : token.text;
    return `<a style="${MapleStyles.link.style}" href="${token.href}">${text}</a>`;
  }

  /**
   * 渲染列表项
   */
  private renderListItem(item: any): string {
    const normalizedTokens = this.normalizeListItemTokens(item.tokens || []);
    const parsedText = this.withInlineContext('default', () => this.parseTokens(normalizedTokens));
    const compacted = this.compactHTML(parsedText);
    
    // 检测是否以反引号开头 - 如果是则不显示圆点且移除边距(使用负边距抵消ul的padding)
    const firstToken = normalizedTokens[0];
    const startsWithBacktick = firstToken && 
      (firstToken.type === 'codespan' || 
       (firstToken.type === 'text' && firstToken.text && firstToken.text.trim().startsWith('`')));
    
    const liStyle = startsWithBacktick 
      ? `${MapleStyles.li.style}list-style-type: none; margin-left: -18px; padding-left: 0;`
      : MapleStyles.li.style;

    if (startsWithBacktick) {
      const codeMatch = compacted.match(/^(<code\b[^>]*>[\s\S]*?<\/code>)(\s*)([\s\S]*)$/);
      if (codeMatch) {
        const labelHtml = codeMatch[1];
        const restRaw = codeMatch[3] || '';
        const restContent = restRaw ? this.compactHTML(restRaw) : '';
        const labelWrapper = `<div style="${MapleStyles.liFlex.label}">${labelHtml}</div>`;
        const contentWrapper = restContent
          ? `<div style="${MapleStyles.liFlex.content}">${restContent}</div>`
          : '';
        return `<li style="${liStyle}"><section style="${MapleStyles.liFlex.container}">${labelWrapper}${contentWrapper}</section></li>`;
      }
    }

    return `<li style="${liStyle}"><section>${compacted}</section></li>`;
  }

  private normalizeListItemTokens(tokens: any[]): any[] {
    if (tokens.length === 1 && tokens[0].type === 'text' && tokens[0].tokens && tokens[0].tokens.length) {
      return tokens[0].tokens;
    }
    return tokens;
  }

  private withInlineContext<T>(context: 'default' | 'plain', fn: () => T): T {
    const previous = this.inlineContext;
    this.inlineContext = context;
    try {
      return fn();
    } finally {
      this.inlineContext = previous;
    }
  }

  /**
   * 紧凑化HTML（保持内容结构不变）
   */
  private compactHTML(html: string): string {
    return html.trim();
  }

  /**
   * 计算字符串的UTF-8字节大小并转换为KB
   */
  private calculateSizeKB(str: string): number {
    const bytes = new TextEncoder().encode(str).length;
    return Math.round((bytes / 1024) * 100) / 100; // 保留2位小数
  }

  /**
   * 转换Markdown为微信H5格式HTML
   * @param markdown - Markdown源码  
   * @returns 包含HTML内容和KB大小的对象（HTML内容符合微信接口content字段要求）
   */
  convert(markdown: string): { html: string; sizeKB: number; warnings: string[] } {
    // 预处理：URL-encode 图片路径中的空格（Typora 等编辑器可能产生含空格路径）
    const warnings: string[] = [];
    markdown = markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
      const trimmed = url.trim();
      if (trimmed.startsWith('/') || trimmed.startsWith('~') || trimmed.startsWith('file://')) {
        warnings.push(`图片 "${alt || trimmed}" 使用本地路径，微信无法访问，请上传到云图库后替换为 https:// 链接`);
      }
      const encoded = trimmed.replace(/ /g, '%20');
      return `![${alt}](${encoded})`;
    });

    // 预处理：将反引号包裹的纯 URL 转为自动链接
    markdown = markdown.replace(/`(https?:\/\/[^\s`]+)`/g, '<$1>');

    let rawHtml = marked.parse(markdown) as string;
    
    // 修正第一个图片的上边距问题：开头的图片不需要上边距
    // 直接替换第一个figure的margin，从 "margin: 30px 10px" 改为 "margin: 0px 10px 30px"
    rawHtml = rawHtml.replace(
      /^(<figure style="[^"]*?)margin:\s*30px\s+10px/,
      '$1margin: 0px 10px 30px'
    );
    
    // 包装在标准容器中，添加必要的标识
    const html = `<div class="${MapleStyles.container.className}" style="${MapleStyles.container.style}">
      <section ${MapleStyles.container.dataAttr} style="${MapleStyles.container.innerStyle}">
        ${rawHtml}
      </section>
    </div>`.trim();
    
    const sizeKB = this.calculateSizeKB(html);
    
    return { html, sizeKB, warnings };
  }


  /**
   * HTML转义
   */
  private escapeHtml(text: string): string {
    const map: { [key: string]: string } = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, (m) => map[m] || m);
  }

           /**
          * 渲染表格头部
          */
         private renderTableHeader(header: any[]): string {
           const cells = header.map(cell => {
             const cellContent = cell.tokens
               ? this.withInlineContext('plain', () => this.parseTokens(cell.tokens))
               : this.escapeHtml(cell.text ?? '');
             return `<th style="${MapleStyles.th.style}">
               <section>
                 <span leaf="">${cellContent}</span>
               </section>
             </th>`;
           }).join('');
           
           return `<tr>${cells}</tr>`;
         }

  /**
   * 渲染表格行
   */
  private renderTableRow(row: any[], index: number): string {
    const isEven = index % 2 === 1; // 因为header算第0行，所以从1开始为偶数行
    const rowStyle = isEven ? MapleStyles.trEven.style : MapleStyles.trOdd.style;
    
    const cells = row.map(cell => {
      const cellContent = cell.tokens
        ? this.withInlineContext('plain', () => this.parseTokens(cell.tokens))
        : this.escapeHtml(cell.text ?? '');
      return `<td style="${MapleStyles.td.style}">
        <section>
          <span leaf="">${cellContent}</span>
        </section>
      </td>`;
    }).join('');
    
    return `<tr style="${rowStyle}">${cells}</tr>`;
  }
}

export function convertToMapleH5(markdown: string): { html: string; sizeKB: number; warnings: string[] } {
  const maker = new MapleH5Maker();
  return maker.convert(markdown);
}
