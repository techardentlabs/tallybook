import { CoreError } from './db.ts';

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff))) {
        return String.fromCodePoint(code);
      }
      return '';
    }
    return ENTITIES[body] ?? m;
  });
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

export function escapeXml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;')).replace(CONTROL, '');
}

export function parseXml(input: string): XNode {
  const src = input.replace(/^﻿/, '').replace(CONTROL, '');
  const root: XNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XNode[] = [root];
  const n = src.length;
  let i = 0;
  const fail = (msg: string): never => {
    throw new CoreError('invalid', `Invalid XML at position ${i}: ${msg}`);
  };
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      const t = src.slice(i);
      if (t.trim()) stack[stack.length - 1].text += decodeEntities(t);
      break;
    }
    if (lt > i) {
      const t = src.slice(i, lt);
      if (t.trim() || stack.length > 1) stack[stack.length - 1].text += decodeEntities(t);
    }
    i = lt;
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end < 0) fail('unterminated comment');
      i = end + 3;
    } else if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      if (end < 0) fail('unterminated CDATA');
      stack[stack.length - 1].text += src.slice(i + 9, end);
      i = end + 3;
    } else if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2);
      if (end < 0) fail('unterminated declaration');
      i = end + 2;
    } else if (src.startsWith('<!', i)) {
      const end = src.indexOf('>', i + 2);
      if (end < 0) fail('unterminated declaration');
      i = end + 1;
    } else if (src[i + 1] === '/') {
      const end = src.indexOf('>', i + 2);
      if (end < 0) fail('unterminated closing tag');
      const name = src.slice(i + 2, end).trim();
      const top = stack[stack.length - 1];
      if (stack.length === 1 || top.name !== name) fail(`unexpected closing tag </${name}>`);
      stack.pop();
      i = end + 1;
    } else {
      let j = i + 1;
      let quote = '';
      while (j < n) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
        j++;
      }
      if (j >= n) fail('unterminated tag');
      let inner = src.slice(i + 1, j);
      const selfClose = inner.endsWith('/');
      if (selfClose) inner = inner.slice(0, -1);
      const m = /^([^\s/>]+)([\s\S]*)$/.exec(inner);
      if (!m) fail('empty tag');
      const node: XNode = { name: m![1], attrs: {}, children: [], text: '' };
      const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      while ((a = attrRe.exec(m![2]))) node.attrs[a[1]] = decodeEntities(a[3] ?? a[4] ?? '');
      stack[stack.length - 1].children.push(node);
      if (!selfClose) stack.push(node);
      i = j + 1;
    }
  }
  if (stack.length > 1) fail(`missing closing tag </${stack[stack.length - 1].name}>`);
  const first = root.children[0];
  if (!first) fail('no content');
  return first;
}

export function childs(node: XNode, name: string): XNode[] {
  return node.children.filter((c) => c.name === name);
}

export function child(node: XNode, name: string): XNode | undefined {
  return node.children.find((c) => c.name === name);
}

export function textOf(node: XNode | undefined, name?: string): string {
  const n = name ? (node ? child(node, name) : undefined) : node;
  return n ? n.text.trim() : '';
}

export function descendants(node: XNode, name: string, out: XNode[] = []): XNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    else descendants(c, name, out);
  }
  return out;
}

export class XmlWriter {
  private parts: string[] = [];
  private depth = 0;

  open(name: string, attrs: Record<string, string> = {}) {
    this.parts.push(`${'  '.repeat(this.depth)}<${name}${this.attrStr(attrs)}>\n`);
    this.depth++;
  }

  close(name: string) {
    this.depth--;
    this.parts.push(`${'  '.repeat(this.depth)}</${name}>\n`);
  }

  leaf(name: string, value: string | number, attrs: Record<string, string> = {}) {
    const v = escapeXml(String(value));
    this.parts.push(`${'  '.repeat(this.depth)}<${name}${this.attrStr(attrs)}>${v}</${name}>\n`);
  }

  toString(): string {
    return this.parts.join('');
  }

  private attrStr(attrs: Record<string, string>): string {
    return Object.entries(attrs).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('');
  }
}
