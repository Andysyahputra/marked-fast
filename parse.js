// parse.js — dependency-free CommonMark 0.31.2 + GFM parser.
// Output is byte-identical to marked 18.1.3 with default options
// (gfm on, breaks off, pedantic off, xhtml off).
// Written from the CommonMark/GFM specifications and black-box probing
// of marked's output; it does not import or embed marked.

export function parse(src) {
  src = String(src).replace(/\r\n?/g, '\n');
  const doc = parseBlocks(src);
  collectDefinitions(doc);
  return renderBlocks(doc.children, doc);
}

export default parse;

// ---------------------------------------------------------------- utilities

const PUNCT_RE = /[!-\/:-@\[-`{-~]/;
function isPunct(ch) {
  return ch !== undefined && PUNCT_RE.test(ch);
}
const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
function isUnicodePunct(ch) {
  return ch !== undefined && UNICODE_PUNCT_RE.test(ch);
}
const UNICODE_SPACE_RE = /[\p{Zs}]/u;
function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\v' || ch === '\f' || ch === '\r' ||
    (ch !== undefined && UNICODE_SPACE_RE.test(ch));
}
function isBlankLine(s) {
  return /^[ \t]*$/.test(s);
}

// Escape text for HTML output. `&` is left alone when it starts something
// that looks like an entity reference (&word; or &#...;), matching marked.
const NO_ENCODE_RE = /&(?!(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)/g;
function escapeText(s) {
  return s.replace(NO_ENCODE_RE, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
// Full escape used for code spans / code blocks: every & is escaped.
function escapeFull(s) {
  return s.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Decode numeric character references (&#65; &#x41;). Invalid code points
// become U+FFFD. Named references are deliberately NOT decoded here:
// marked leaves them as literal text.
const NUMERIC_ENTITY_RE = /&#[Xx]([0-9A-Fa-f]{1,6});|&#(\d{1,7});/g;
function decodeNumericEntities(s) {
  return s.replace(NUMERIC_ENTITY_RE, (m, hex, dec) => {
    let cp;
    if (hex !== undefined) cp = parseInt(hex, 16);
    else cp = parseInt(dec, 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    return String.fromCodePoint(cp);
  });
}

// Backslash-unescape: \ + ASCII punctuation -> the punctuation itself.
const BACKSLASH_ESCAPE_RE = /\\([!-\/:-@\[-`{-~])/g;
function unescape(s) {
  return s.replace(BACKSLASH_ESCAPE_RE, '$1');
}

// Normalize a link label: trim, collapse internal whitespace, casefold.
function normalizeLabel(s) {
  // Unicode case folding: ß/ẞ fold to "ss" (toLowerCase gives ß for ẞ)
  return s.trim().replace(/\s+/g, ' ').toLowerCase().replace(/ß/g, 'ss');
}

// true if s contains an unescaped '[' (link labels may not contain one)
function labelHasBracket(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { i++; continue; }
    if (s[i] === '[') return true;
  }
  return false;
}

// Process a link destination the way marked does: backslash-unescape,
// percent-encode via encodeURI, then escape for the attribute.
// A '%' that is already part of a valid %XX escape is left as-is.
function encodeHref(s) {
  return s.replace(/%[0-9A-Fa-f]{2}|[^%]+|%/g, (m) => {
    if (/^%[0-9A-Fa-f]{2}$/.test(m)) return m;
    // a bare % (not part of a %XX sequence) stays literal
    if (m === '%') return '%';
    return encodeURI(m);
  });
}
function cleanHref(dest) {
  return escapeText(encodeHref(unescape(dest)));
}
function cleanTitle(title) {
  return escapeText(unescape(title));
}

// Scan an HTML tag starting at text[i] === '<'. Returns the index just
// past the closing '>' or -1. Quoted attribute values may contain '>',
// '<' and newlines; closing tags take no attributes; an attribute must
// be preceded by whitespace after the tag name.
function scanHtmlTag(text, i) {
  let j = i + 1;
  let closing = false;
  if (text[j] === '/') { closing = true; j++; }
  const nm = /^[A-Za-z][A-Za-z0-9-]*/.exec(text.slice(j));
  if (!nm) return -1;
  j += nm[0].length;
  if (closing) {
    while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
    return text[j] === '>' ? j + 1 : -1;
  }
  const nx = text[j];
  if (nx !== undefined && nx !== ' ' && nx !== '\t' && nx !== '\n' && nx !== '>' && nx !== '/') return -1;
  while (j < text.length) {
    const c = text[j];
    if (c === '>') return j + 1;
    if (c === '/' && text[j + 1] === '>') return j + 2;
    if (c === ' ' || c === '\t' || c === '\n') { j++; continue; }
    // attribute name: [A-Za-z_:][A-Za-z0-9_.:-]*
    const am = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(text.slice(j));
    if (!am) return -1;
    j += am[0].length;
    while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
    if (text[j] === '=') {
      j++;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
      const q = text[j];
      if (q === '"' || q === "'") {
        j++;
        while (j < text.length && text[j] !== q) j++;
        if (j >= text.length) return -1;
        j++;
      } else {
        const vs = j;
        while (j < text.length) {
          const d = text[j];
          if (d === ' ' || d === '\t' || d === '\n' || d === '"' || d === "'" || d === '=' || d === '<' || d === '>' || d === '`') break;
          j++;
        }
        if (j === vs) return -1;
      }
      // after a value, only whitespace, '>' or '/>' may follow
      if (j < text.length) {
        const nx = text[j];
        if (nx !== ' ' && nx !== '\t' && nx !== '\n' && nx !== '>' && nx !== '/') return -1;
      }
    }
  }
  return -1;
}

// ---------------------------------------------------------------- entities
// (Named references pass through untouched; only numeric ones decode, so no
// large entity table is needed.)

// ---------------------------------------------------------------- blocks

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*)?|[ \t]*)$/;
const HR_RE = /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const BULLET_RE = /^ {0,3}([-+*])([ \t]+|$)/;
const ORDERED_RE = /^ {0,3}(\d{1,9})([.)])([ \t]+|$)/;
const BLOCKQUOTE_RE = /^ {0,3}>[ \t]?/;
const INDENTED_CODE_RE = /^(?:( {4})|\t)/;

function parseBlocks(src) {
  const rawLines = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') { rawLines.push(src.slice(start, i + 1)); start = i + 1; }
  }
  if (start < src.length) rawLines.push(src.slice(start));
  const n = rawLines.length;
  const text = rawLines.map(l => (l.endsWith('\n') ? l.slice(0, -1) : l));
  const hasNL = rawLines.map(l => l.endsWith('\n'));

  const doc = { type: 'document', children: [], open: true, parent: null };
  let tip = doc;
  let lastLineBlank = false;
  // blankness finalize() should record: true if this line is blank (or
  // effectively blank) or the previous line was blank; captured at the
  // start of each line, before this line resets lastLineBlank
  let finBlank = false;
  const allDefs = [];

  // per-line cursor
  let S = '';
  let off = 0;
  let col = 0;

  function lastChild(b) {
    const c = b.children;
    return c.length ? c[c.length - 1] : null;
  }
  function addChild(parent, child) {
    child.parent = parent;
    child.children = child.children || [];
    // a new block added after a blank line, when the parent already has
    // content, makes the list loose (new item after a blank line, or a
    // second block in an item after a blank line)
    if (finBlank && parent.children.length > 0 &&
        (parent.type === 'list_item' || parent.type === 'list')) {
      parent._loose = true;
    }
    parent.children.push(child);
    tip = child;
    return child;
  }
  function finalize(b) {
    b.open = false;
    b._lastLineBlank = finBlank;
    if (b.type === 'html') {
      // the trailing newline of the last line is kept only when the
      // block ended at its end-condition (or EOF) and the next line is
      // not blank (or it is the document's last line)
      b.text = b.lines.join('\n') + (b._keepTrailingNL && hasNL[b._lastIdx] && (b._lastIdx === n - 1 || !isBlankLine(text[b._lastIdx + 1])) ? '\n' : '');
    }
    if (b.type === 'list') {
      // looseness: blank line between two items, or two blocks of one
      // item separated by a blank line.
      let loose = b._loose || false;
      for (const item of b.children) {
        if (item._loose) loose = true;
        if (item._lastLineBlank && item !== b.children[b.children.length - 1]) loose = true;
        for (let k = 0; k + 1 < item.children.length; k++) {
          if (item.children[k]._lastLineBlank) loose = true;
        }
      }
      b.tight = !loose;
    }
    if (b.type === 'code' && !b.fenced) {
      // strip trailing blank lines from indented code
      while (b.lines.length && isBlankLine(b.lines[b.lines.length - 1])) b.lines.pop();
    }
    if (b.type === 'paragraph') {
      // a paragraph that is only reference definitions disappears
      // (definitions are collected globally in collectDefinitions)
      extractDefinitions(b);
      if (b.defs.length) allDefs.push(...b.defs);
      if (b.lines.length === 0) {
        const p = b.parent;
        const idx = p.children.indexOf(b);
        if (idx >= 0) p.children.splice(idx, 1);
      }
    }
    if (tip === b) tip = b.parent;
  }
  function closeUnmatched(toContainer) {
    // close blocks from tip up to (not including) toContainer
    while (tip !== toContainer && tip) {
      const p = tip.parent;
      finalize(tip);
      tip = p;
    }
  }
  function peek() { return off < S.length ? S[off] : ''; }
  function rest() { return S.slice(off); }
  // advance the cursor past up to `target` columns of indentation.
  function advanceIndent(target) {
    while (col < target) {
      const ch = S[off];
      if (ch === ' ') { off++; col++; }
      else if (ch === '\t') {
        const next = col + (4 - (col % 4));
        if (next <= target) { off++; col = next; }
        else {
          const remain = next - target;
          S = S.slice(0, off) + ' '.repeat(remain) + S.slice(off + 1);
          col = target;
        }
      } else return false;
    }
    return true;
  }
  // consume a single optional space (or a tab, partially) after a marker
  function advanceOneSpace() {
    const ch = S[off];
    if (ch === ' ') { off++; col++; return true; }
    if (ch === '\t') {
      const next = col + (4 - (col % 4));
      if (next <= col + 1) { off++; col = next; }
      else {
        S = S.slice(0, off) + ' '.repeat(next - col - 1) + S.slice(off + 1);
        col = col + 1;
      }
      return true;
    }
    return false;
  }

  // ---- block start matchers (operate on the line from the cursor) ----
  function matchFence() {
    const m = FENCE_RE.exec(rest());
    if (!m) return null;
    const fence = m[1];
    const info = m[2];
    if (fence[0] === '`' && info.includes('`')) return null;
    const lead = rest().length - rest().trimStart().length;
    return { fence, info: info.trim(), fenceIndent: lead, fenceLen: fence.length };
  }
  function matchATX() {
    const m = ATX_RE.exec(rest());
    if (!m) return null;
    let content = m[2] === undefined ? '' : m[2];
    // strip closing hash sequence (including a content of only hashes)
    if (/^[ \t]*#+[ \t]*$/.test(content)) content = '';
    else content = content.replace(/[ \t]+#+[ \t]*$/, '');
    content = content.replace(/^[ \t]+|[ \t]+$/g, '');
    return { level: m[1].length, content };
  }
  function matchHR() { return HR_RE.test(rest()); }
  function matchSetext() {
    const m = SETEXT_RE.exec(rest());
    return m ? (m[1][0] === '=' ? 1 : 2) : 0;
  }
  function matchList() {
    let m = BULLET_RE.exec(rest());
    if (m) {
      return { ordered: false, bullet: m[1], start: null, delim: null, markerLen: 1, spaces: m[2] };
    }
    m = ORDERED_RE.exec(rest());
    if (m) {
      return { ordered: true, bullet: null, start: parseInt(m[1], 10), delim: m[2], markerLen: m[1].length + 1, spaces: m[2] };
    }
    return null;
  }
  function matchHtmlType() {
    const r = rest();
    const m0 = /^ {0,3}</.exec(r);
    if (!m0) return 0;
    const after = r.slice(m0[0].length - 1); // starts at '<'
    if (/^<(script|pre|style|textarea)([\s>]|$)/i.test(after)) return 1;
    if (after.startsWith('<!--')) return 2;
    if (after.startsWith('<?')) return 3;
    if (/^<![A-Za-z]/.test(after)) return 4;
    if (after.startsWith('<![CDATA[')) return 5;
    const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)((?:[\s\/>]|$))/i.exec(after);
    if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return 6;
    // type 7: a complete open/close tag alone on the line
    const tagEnd = scanHtmlTag(after, 0);
    if (tagEnd !== -1 && /^[ \t]*$/.test(after.slice(tagEnd))) return 7;
    return 0;
  }
  function htmlEndsAt(line, type) {
    if (type === 1) return /<\/(script|pre|style|textarea)[\s>]/i.test(line) || /<\/(script|pre|style|textarea)>$/i.test(line);
    if (type === 2) return line.includes('-->');
    if (type === 3) return line.includes('?>');
    if (type === 4) return line.includes('>');
    if (type === 5) return line.includes(']]>');
    return false;
  }
  function isTableDelimiter(line) {
    if (!line.includes('|')) return false;
    const cells = splitTableRow(line);
    if (cells.length === 0) return false;
    for (const c of cells) {
      if (!/^:?-+:?$/.test(c.trim())) return false;
    }
    return true;
  }
  function splitTableRow(line) {
    // split on unescaped pipes; drop a leading/trailing empty cell
    // caused by a leading/trailing pipe
    const cells = [];
    let cur = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\\' && i + 1 < line.length && line[i + 1] === '|') { cur += '|'; i++; }
      else if (ch === '|') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    if (cells.length > 1 && cells[0].trim() === '') cells.shift();
    if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop();
    return cells.map(c => c.trim());
  }

  // Does the current line (from the cursor) interrupt an open paragraph?
  // Returns 0 = no, 1 = yes, 2 = table delimiter (needs the paragraph).
  function paragraphInterruptKind(para) {
    if (para && para.type === 'paragraph' && isTableDelimiter(rest())) {
      const plines = para.lines;
      const h = plines[plines.length - 1];
      if (h !== undefined && h.includes('|') && splitTableRow(h).length > 0) return 2;
    }
    if (matchSetext()) return 1;
    if (matchFence()) return 1;
    const ht = matchHtmlType();
    if (ht && ht !== 7) return 1;
    if (matchATX()) return 1;
    if (matchHR()) return 1;
    if (BLOCKQUOTE_RE.test(rest())) return 1;
    const lm = matchList();
    if (lm && (!lm.ordered || lm.start === 1)) return 1;
    return 0;
  }
  // Split an open paragraph into a table (header = paragraph's last line).
  // Returns the table node or null.
  function doTableSplit(parent, li) {
    const last = lastChild(parent);
    if (!last || last.type !== 'paragraph' || !last.open) return null;
    if (!isTableDelimiter(rest())) return null;
    const plines = last.lines;
    const headerLine = plines[plines.length - 1];
    if (headerLine === undefined || !headerLine.includes('|')) return null;
    const headerCells = splitTableRow(headerLine);
    if (headerCells.length === 0) return null;
    const aligns = splitTableRow(rest()).map(c => {
      const t = c.trim();
      if (t.startsWith(':') && t.endsWith(':')) return 'center';
      if (t.endsWith(':')) return 'right';
      if (t.startsWith(':')) return 'left';
      return null;
    });
    // the delimiter row must have exactly as many cells as the header
    if (aligns.length !== headerCells.length) return null;
    plines.pop();
    if (plines.length === 0) {
      const idx = parent.children.indexOf(last);
      if (idx >= 0) parent.children.splice(idx, 1);
      if (tip === last) tip = parent;
    }
    const table = addChild(parent, { type: 'table', header: headerCells, aligns, rows: [], open: true });
    table._lastIdx = li;
    tip = table;
    return table;
  }

  // Expand tabs in the leading whitespace of the current line (from
  // off) to spaces, based on the current column. Leaves off at the
  // start of the expanded whitespace so rest() includes it. Used for
  // fenced code content, where a leading tab is verbatim content but
  // must be expanded to spaces.
  function expandLeadingTabs() {
    let c = col;
    let i = off;
    let out = '';
    while (i < S.length && (S[i] === ' ' || S[i] === '\t')) {
      if (S[i] === ' ') { out += ' '; c++; i++; }
      else {
        const next = c + (4 - (c % 4));
        out += ' '.repeat(next - c);
        c = next;
        i++;
      }
    }
    if (i > off) {
      S = S.slice(0, off) + out + S.slice(i);
      col = c;
    }
  }

  // Match a blockquote marker at the cursor (up to 3 spaces, '>', then
  // one optional space column) and advance past it.
  function matchBlockquote() {
    let i = off;
    let c = col;
    let spaces = 0;
    while (i < S.length && S[i] === ' ' && spaces < 3) { i++; c++; spaces++; }
    if (S[i] !== '>') return false;
    i++; c++;
    if (S[i] === ' ') { i++; c++; }
    else if (S[i] === '\t') {
      const next = c + (4 - (c % 4));
      if (next <= c + 1) { i++; c = next; }
      else {
        S = S.slice(0, i) + ' '.repeat(next - c - 1) + S.slice(i + 1);
        c = c + 1;
      }
    }
    off = i; col = c;
    return true;
  }

  // ---- main line loop ----
  for (let li = 0; li < n; li++) {
    S = text[li];
    off = 0;
    col = 0;
    const lineBlank = isBlankLine(S);
    // finalize() records whether this line (or the one before it) was
    // blank; capture it before this line resets lastLineBlank
    finBlank = lastLineBlank;
    if (!lineBlank) lastLineBlank = false;

    // Phase 1: descend through open containers. Runs for blank lines
    // too: a blank line with no '>' ends a blockquote, while blank
    // lines keep list items open.
    let container = doc;
    let allMatched = true;
    while (true) {
      const last = lastChild(container);
      if (!last || !last.open) break;
      if (last.type === 'blockquote') {
        if (!matchBlockquote()) { allMatched = false; break; }
        container = last;
      } else if (last.type === 'list') {
        container = last;
      } else if (last.type === 'list_item') {
        // indent is measured relative to where this line's containers
        // ended (a blockquote's '>' may end at a different column than
        // the item's first line); a blank remainder keeps the item open
        if (indentOf(rest()) < last.contentIndentRel && !isBlankLine(rest())) { allMatched = false; break; }
        advanceIndent(col + last.contentIndentRel);
        container = last;
      } else break;
    }

    if (lineBlank) {
      // Blank line inside matched containers is content for fenced code
      // (verbatim, minus the fence indent) and indented code (minus 4
      // columns), and for HTML blocks of types 1-6; it ends paragraphs,
      // tables and type-7 HTML blocks. A blank line that fails to match
      // a container closes everything up to the matched container.
      lastLineBlank = true;
      finBlank = true;
      if (allMatched) {
        if (tip.type === 'code' && tip.fenced) {
          advanceIndent(col + tip.fenceIndent);
          tip.lines.push(rest());
          tip._lastIdx = li;
        } else if (tip.type === 'code') {
          advanceIndent(col + 4);
          tip.lines.push(rest());
          tip._lastIdx = li;
        } else if (tip.type === 'html') {
          // types 1-5 continue through blank lines; types 6/7 end
          if (tip.htmlType === 6 || tip.htmlType === 7) finalize(tip);
          else { tip.lines.push(rest()); tip._lastIdx = li; }
        } else if (tip.type === 'paragraph') finalize(tip);
        else if (tip.type === 'table') finalize(tip);
        else if (tip.type === 'list_item' && tip.children.length === 0) finalize(tip);
      } else {
        closeUnmatched(container);
      }
      continue;
    }
    // A line that is empty after its containers matched (e.g. '>' or
    // '>>' alone): ends the paragraph, is content for code/html. A
    // remainder of only spaces is paragraph content, not a blank line.
    // A blank remainder inside a blockquote is a blank line inside the
    // blockquote only, not at list level, so it does not set the blank
    // flag (it must not loosen the enclosing list).
    if (rest() === '') {
      if (container.type === 'list_item' || container.type === 'list' ||
          container.type === 'document') {
        lastLineBlank = true;
        finBlank = true;
      }
      if (!allMatched) {
        closeUnmatched(container);
        continue;
      }
      if (tip.type === 'paragraph') finalize(tip);
      else if (tip.type === 'table') finalize(tip);
      else if (tip.type === 'html') {
        // types 1-5 continue through blank lines; types 6/7 end
        if (tip.htmlType === 6 || tip.htmlType === 7) finalize(tip);
        else { tip.lines.push(rest()); tip._lastIdx = li; }
      } else if (tip.type === 'code' && tip.fenced) {
        const colBefore = col;
        advanceIndent(col + tip.fenceIndent);
        if (col === colBefore && col > 0) expandLeadingTabs();
        tip.lines.push(rest());
        tip._lastIdx = li;
      } else if (tip.type === 'code') {
        advanceIndent(col + 4);
        tip.lines.push(rest());
        tip._lastIdx = li;
      }
      continue;
    }

    // Phase 2: continue an open leaf block, or handle a line that
    // failed to match its containers.
    if (!allMatched) {
      if (tip.type === 'paragraph') {
        // A lazy setext-1 underline ('=' only) never interrupts: it is
        // paragraph text. If the previous line was lazy too, marked
        // indents it by 4 spaces inside a blockquote, or makes it a
        // heading inside an ordered list item.
        if (matchSetext() === 1) {
          const r = rest();
          if (tip._prevLazy && tip.parent && tip.parent.type === 'blockquote') {
            tip.lines.push(/^ {0,3}=/.test(r) ? '    ' + r.replace(/^ +/, '') : r);
            tip._lastIdx = li;
            tip._prevLazy = true;
          } else if (tip._prevLazy && nearestList(tip) && nearestList(tip).ordered) {
            tip.type = 'heading';
            tip.level = 1;
            finalize(tip);
          } else {
            tip.lines.push(paraLine(r, true, hasListAncestor(tip)));
            tip._lastIdx = li;
            tip._prevLazy = true;
          }
          continue;
        }
        // A new item of the enclosing list starts a new item instead of
        // continuing the paragraph, whatever its type: a different
        // delimiter (or bullet vs ordered) starts a new list.
        if (container.type === 'list') {
          const lm0 = matchList();
          if (lm0) {
            closeUnmatched(container);
          }
        }
        // Lazy continuation, unless the line starts a block that
        // interrupts a paragraph (setext, ATX, fence, html 1-6, hr,
        // blockquote, list, table delimiter). The paragraph may already
        // have been closed by the same-list check above.
        if (tip.type === 'paragraph') {
          const interrupt = paragraphInterruptKind(tip);
          if (interrupt === 0) {
            tip.lines.push(paraLine(rest(), true, hasListAncestor(tip)));
            tip._lastIdx = li;
            tip._prevLazy = true;
            continue;
          }
          if (interrupt === 2) {
            if (doTableSplit(tip.parent, li)) continue;
          }
        }
        closeUnmatched(container);
      } else {
        closeUnmatched(container);
      }
    } else if (tip.type === 'code' && tip.fenced) {
      // closing fence?
      const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(rest());
      if (cm && cm[1][0] === tip.fenceChar && cm[1].length >= tip.fenceLen) {
        finalize(tip);
        continue;
      }
      const colBefore = col;
      advanceIndent(col + tip.fenceIndent);
      // a leading tab is expanded to spaces only when the line is
      // inside a container (col > 0) and the fence-indent removal
      // advanced nothing; at the top level a tab stays literal
      if (col === colBefore && col > 0) expandLeadingTabs();
      tip.lines.push(rest());
      tip._lastIdx = li;
      continue;
    } else if (tip.type === 'code' && !tip.fenced) {
      const saveOff = off, saveCol = col, saveS = S;
      if (advanceIndent(col + 4)) {
        tip.lines.push(rest());
        tip._lastIdx = li;
        continue;
      }
      off = saveOff; col = saveCol; S = saveS;
      finalize(tip);
      // fall through: re-process the line as a new block
    } else if (tip.type === 'html') {
      tip.lines.push(rest());
      tip._lastIdx = li;
      if (htmlEndsAt(rest(), tip.htmlType)) { tip._keepTrailingNL = true; finalize(tip); }
      continue;
    } else if (tip.type === 'table') {
      // A line that starts a new block (heading, hr, fence, html,
      // blockquote, list) ends the table; anything else is a row,
      // even without pipes.
      if (paragraphInterruptKind(null) === 1) {
        finalize(tip);
        // fall through to the main loop to re-process the line
      } else {
        tip.rows.push(splitTableRow(rest()));
        tip._lastIdx = li;
        continue;
      }
    }

    // Now container is the innermost matched container.
    // Loop: create blocks until a leaf consumes the line.
    while (true) {
      // A list only accepts new items; anything else closes it. A
      // thematic break also closes a list (it takes precedence over a
      // list marker: '* * *' is an hr, not an item).
      if (container.type === 'list' && (!matchList() || matchHR())) {
        finalize(container);
        container = container.parent;
        continue;
      }
      const last = lastChild(container);
      const paraOpen = last && last.open && last.type === 'paragraph';

      // table delimiter: split the open paragraph
      if (paraOpen && isTableDelimiter(rest())) {
        if (doTableSplit(container, li)) break;
      }

      // setext underline converts the open paragraph
      if (paraOpen) {
        const sl = matchSetext();
        if (sl) {
          // reference definitions are extracted from the paragraph
          // first; if nothing is left, there is no heading and this
          // line starts a new block instead
          extractDefinitions(last);
          if (last.defs.length) allDefs.push(...last.defs);
          if (last.lines.length === 0) {
            const ridx = last.parent.children.indexOf(last);
            if (ridx >= 0) last.parent.children.splice(ridx, 1);
            if (tip === last) tip = last.parent;
            continue;
          }
          last.type = 'heading';
          last.level = sl;
          finalize(last);
          break;
        }
      }

      // indented code (never interrupts a paragraph)
      if (!paraOpen) {
        const saveOff = off, saveCol = col, saveS = S;
        if (advanceIndent(col + 4)) {
          const code = addChild(container, { type: 'code', fenced: false, info: '', lines: [rest()], open: true });
          code._lastIdx = li;
          break;
        }
        off = saveOff; col = saveCol; S = saveS;
      }

      // fenced code
      const fence = matchFence();
      if (fence) {
        if (paraOpen) finalize(last);
        const code = addChild(container, { type: 'code', fenced: true, info: fence.info, fenceChar: fence.fence[0], fenceLen: fence.fenceLen, fenceIndent: fence.fenceIndent, lines: [], open: true });
        code._lastIdx = li;
        break;
      }

      // html block (type 7 cannot interrupt a paragraph)
      const htype = matchHtmlType();
      if (htype && (!paraOpen || htype !== 7)) {
        if (paraOpen) finalize(last);
        const html = addChild(container, { type: 'html', htmlType: htype, lines: [rest()], open: true });
        html._lastIdx = li;
        if (htmlEndsAt(rest(), htype)) { html._keepTrailingNL = true; finalize(html); }
        break;
      }

      // ATX heading
      const atx = matchATX();
      if (atx) {
        if (paraOpen) finalize(last);
        const h = addChild(container, { type: 'heading', level: atx.level, lines: [atx.content], open: true });
        h._lastIdx = li;
        finalize(h);
        break;
      }

      // thematic break (checked before lists: '* * *' is an hr)
      if (matchHR()) {
        if (paraOpen) finalize(last);
        const hr = addChild(container, { type: 'thematic_break', open: true });
        hr._lastIdx = li;
        finalize(hr);
        break;
      }

      // list
      const lm = matchList();
      // an empty list item cannot interrupt a paragraph
      const itemEmpty = lm && /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]*$/.test(rest());
      if (lm && (!paraOpen || lm.ordered === false || lm.start === 1) && !(paraOpen && itemEmpty)) {
        if (paraOpen) finalize(last);
        // the marker may be preceded by up to 3 spaces
        const lead = rest().length - rest().trimStart().length;
        const markerCol = col + lead;
        const markerEndCol = markerCol + lm.markerLen;
        let p = off + lead + lm.markerLen;
        let c = markerEndCol;
        let adv = 0;
        while (p < S.length && (S[p] === ' ' || S[p] === '\t')) {
          if (S[p] === ' ') { p++; c++; adv++; }
          else { const nx = c + (4 - (c % 4)); p++; c = nx; adv = nx - markerEndCol; }
          if (adv >= 5) break;
        }
        let contentIndent;
        if (p >= S.length || adv === 0) contentIndent = markerEndCol + 1;
        else if (adv <= 4) contentIndent = c;
        else contentIndent = markerEndCol + 1;
        // indent of the item's content relative to where this line's
        // containers ended (a blockquote's '>' may end at a different
        // column on later lines)
        const contentIndentRel = contentIndent - col;
        // same-type check against an existing list
        let list = null;
        if (container.type === 'list') list = container;
        else if (last && last.open && last.type === 'list') list = last;
        if (list) {
          const sameType = lm.ordered === list.ordered &&
            (lm.ordered ? lm.delim === list.delim : lm.bullet === list.bullet);
          if (!sameType) {
            if (container.type === 'list') {
              finalize(list);
              container = list.parent;
              continue;
            }
            list = null;
          }
        }
        if (!list) {
          list = addChild(container, { type: 'list', ordered: lm.ordered, start: lm.ordered ? lm.start : null, delim: lm.delim, bullet: lm.bullet, open: true });
          list._lastIdx = li;
        }
        const item = addChild(list, { type: 'list_item', contentIndent, contentIndentRel, open: true });
        item._lastIdx = li;
        // position the cursor just past the marker, then at the content indent
        off = off + lead + lm.markerLen;
        col = markerEndCol;
        advanceIndent(contentIndent);
        if (off >= S.length) {
          // empty item: nothing more on this line
          break;
        }
        container = item;
        continue;
      }

      // blockquote
      if (matchBlockquote()) {
        if (paraOpen) finalize(last);
        const bq = addChild(container, { type: 'blockquote', open: true });
        bq._lastIdx = li;
        container = bq;
        continue;
      }

      // paragraph (new or continued); a remainder of only spaces does
      // not start a paragraph (and the line is not a blank line)
      if (!paraOpen && isBlankLine(rest())) {
        break;
      }
      if (paraOpen) {
        last.lines.push(paraLine(rest(), false, hasListAncestor(last)));
        last._lastIdx = li;
        last._prevLazy = false;
      } else {
        const para = addChild(container, { type: 'paragraph', lines: [rest()], open: true });
        para._lastIdx = li;
        para._prevLazy = false;
      }
      break;
    }
  }

  // close everything left open (EOF: html blocks keep their trailing NL)
  while (tip !== doc && tip) {
    const p = tip.parent;
    if (tip.type === 'html') tip._keepTrailingNL = true;
    finalize(tip);
    tip = p;
  }
  doc.open = false;
  doc._defs = allDefs;
  return doc;
}

function indentOf(s) {
  let c = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ') c++;
    else if (s[i] === '\t') c += 4 - (c % 4);
    else break;
  }
  return c;
}

// Remove the first 4 columns of leading indentation from s (tab expands
// to the next multiple of 4). Caller checks indentOf(s) >= 4 first.
function strip4(s) {
  let col = 0;
  let i = 0;
  while (i < s.length && col < 4) {
    const ch = s[i];
    if (ch === ' ') { i++; col++; }
    else if (ch === '\t') { const nx = col + (4 - (col % 4)); if (nx > 4) break; i++; col = nx; }
    else break;
  }
  return s.slice(i);
}

// A paragraph continuation line: marked strips 4 columns of leading
// indent when the line is a lazy continuation or the paragraph lives
// inside a list item; matched lines in blockquotes and at doc level keep
// their indent.
function paraLine(s, lazy, inListItem) {
  if ((lazy || inListItem) && indentOf(s) >= 4) return strip4(s);
  return s;
}

function hasListAncestor(b) {
  let p = b.parent;
  while (p) { if (p.type === 'list_item') return true; p = p.parent; }
  return false;
}

// Nearest enclosing list of block b, or null.
function nearestList(b) {
  let p = b.parent;
  while (p) { if (p.type === 'list') return p; p = p.parent; }
  return null;
}

// Extract link reference definitions from the start of a paragraph.
// Returns nothing; mutates the paragraph's lines and records defs on it.
function extractDefinitions(para) {
  const defs = [];
  let i = 0;
  while (i < para.lines.length) {
    const def = tryParseDefinition(para.lines, i);
    if (!def) break;
    defs.push(def);
    i = def.nextLine;
  }
  para.lines.splice(0, i);
  para.defs = defs;
}

// Parse a link title from the start of `tail` (which may span lines,
// joined by '\n'). Returns { title, newlines } (newlines = lines spanned
// past the first) or null if the tail does not start with a valid title.
function parseRefTitle(tail) {
  let i = 0;
  while (i < tail.length && (tail[i] === ' ' || tail[i] === '\t' || tail[i] === '\n')) i++;
  if (i >= tail.length) return null;
  const q = tail[i];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const closeQ = q === '(' ? ')' : q;
  let j = i + 1;
  let ok = false;
  while (j < tail.length) {
    const c = tail[j];
    if (c === '\\' && j + 1 < tail.length) { j += 2; continue; }
    if (c === closeQ) { ok = true; break; }
    if (q === '(' && c === '(') break;
    j++;
  }
  if (!ok) return null;
  const after = tail.slice(j + 1);
  const nlIdx = after.indexOf('\n');
  const restOfLine = nlIdx === -1 ? after : after.slice(0, nlIdx);
  if (!/^[ \t]*$/.test(restOfLine)) return null;
  const newlines = (tail.slice(0, j + 1).match(/\n/g) || []).length;
  return { title: unescape(tail.slice(i + 1, j)), newlines };
}

// Parse one reference definition starting at lines[i]. Returns
// { label, dest, title, nextLine } or null.
function tryParseDefinition(lines, i) {
  // The label may span lines, so search the paragraph's remaining
  // text joined by newlines for the matching ']'.
  const text = lines.slice(i).join('\n');
  const m = /^ {0,3}\[/.exec(text);
  if (!m) return null;
  let depth = 0;
  let k = m[0].length;
  let labelEnd = -1;
  for (; k < text.length; k++) {
    const ch = text[k];
    if (ch === '\\' && k + 1 < text.length) { k++; continue; }
    if (ch === '`') {
      let n = 0;
      while (k + n < text.length && text[k + n] === '`') n++;
      const close = text.indexOf('`'.repeat(n), k + n);
      if (close === -1) { k = text.length; break; }
      k = close + n - 1;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      if (depth === 0) { labelEnd = k; break; }
      depth--;
    }
  }
  if (labelEnd === -1) return null;
  const rawLabel = text.slice(m[0].length, labelEnd);
  if (!rawLabel.trim()) return null;
  if (labelHasBracket(rawLabel)) return null;
  if (text[labelEnd + 1] !== ':') return null;
  // line index (absolute) and column just past the ':' in that line
  let relLine = 0;
  let lineStartOff = 0;
  for (let t = 0; t <= labelEnd + 1 && t < text.length; t++) {
    if (text[t] === '\n') { relLine++; lineStartOff = t + 1; }
  }
  let j = i + relLine;
  let restStr = lines[j].slice(labelEnd + 2 - lineStartOff).trimStart();
  // the destination may be on the next line
  if (restStr === '') {
    if (j + 1 >= lines.length || lines[j + 1].trim() === '') return null;
    j++;
    restStr = lines[j].trimStart();
  }
  let dest = '';
  if (restStr.startsWith('<')) {
    const end = restStr.indexOf('>');
    if (end === -1) return null;
    dest = restStr.slice(1, end);
    restStr = restStr.slice(end + 1);
  } else {
    const dm = /^[^\s]+/.exec(restStr);
    if (!dm) return null;
    dest = dm[0];
    // bare destinations need balanced parens (unescaped)
    let bal = 0;
    for (let q = 0; q < dest.length; q++) {
      if (dest[q] === '\\') { q++; continue; }
      if (dest[q] === '(') bal++;
      else if (dest[q] === ')') { bal--; if (bal < 0) return null; }
    }
    if (bal !== 0) return null;
    restStr = restStr.slice(dest.length);
  }
  dest = unescape(dest);
  // optional title: on the same line as the destination (junk there
  // invalidates the definition), or on the immediately following line
  // (a non-title next line just means no title). Titles may span lines.
  let title = null;
  if (restStr.trim() !== '') {
    // a title on this line needs whitespace separating it from the dest
    if (!/^[ \t]/.test(restStr)) return null;
    const parsed = parseRefTitle([restStr, ...lines.slice(j + 1)].join('\n'));
    if (!parsed) return null;
    title = parsed.title;
    j = j + parsed.newlines;
  } else if (j + 1 < lines.length) {
    const nl = lines[j + 1].trimStart();
    if (nl.startsWith('"') || nl.startsWith("'") || nl.startsWith('(')) {
      // a malformed title on the next line just means no title
      const parsed = parseRefTitle([lines[j + 1], ...lines.slice(j + 2)].join('\n'));
      if (parsed) {
        title = parsed.title;
        j = j + 1 + parsed.newlines;
      }
    }
  }
  return { label: normalizeLabel(rawLabel), dest, title, nextLine: j + 1 };
}

// Collect definitions from the whole document into doc.refs (first wins).
function collectDefinitions(doc) {
  const refs = new Map();
  for (const d of doc._defs || []) {
    if (!refs.has(d.label)) refs.set(d.label, { dest: d.dest, title: d.title });
  }
  doc.refs = refs;
}

// ---------------------------------------------------------------- inline

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/;
const EMAIL_LOCAL_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-";
const GFM_SCHEMES = new Set(['http', 'https', 'ftp']);

function parseInline(text, refs, flat) {
  const nodes = [];
  const delims = [];
  let i = 0;
  let textStart = 0;

  function flushText(end) {
    if (end > textStart) {
      const s = decodeNumericEntities(text.slice(textStart, end));
      if (s) nodes.push({ t: 'text', s });
    }
  }
  function pushDelim(char, runNode, num, canOpen, canClose) {
    const d = { char, node: runNode, num, canOpen, canClose, prev: null, next: null };
    if (delims.length) {
      const prev = delims[delims.length - 1];
      prev.next = d;
      d.prev = prev;
    }
    delims.push(d);
    return d;
  }

  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') {
        flushText(i);
        nodes.push({ t: 'br' });
        i += 2;
        // a hard break strips the next line's leading whitespace
        while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
        textStart = i;
      } else if (nx !== undefined && isPunct(nx)) {
        flushText(i);
        nodes.push({ t: 'text', s: nx });
        i += 2; textStart = i;
      } else {
        i++;
      }
    } else if (ch === '`') {
      let n = 0;
      while (i + n < text.length && text[i + n] === '`') n++;
      let j = i + n;
      let found = -1;
      while (j < text.length) {
        if (text[j] === '`') {
          let m = 0;
          while (j + m < text.length && text[j + m] === '`') m++;
          if (m === n) { found = j; break; }
          j += m;
        } else j++;
      }
      if (found === -1) { i += n; continue; }
      flushText(i);
      let content = text.slice(i + n, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && !/^ +$/.test(content)) {
        content = content.slice(1, -1);
      }
      nodes.push({ t: 'code', s: content });
      i = found + n;
      textStart = i;
    } else if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      const isImage = ch === '!';
      const start = isImage ? i + 1 : i;
      const link = tryParseLink(text, start, refs);
      if (link) {
        // In an image's alt text, nested links/images are flattened to
        // their text (an image's alt may not contain another image).
        // In a link's text, nested images are allowed, nested links are not.
        // The text is parsed in the current mode so a link whose text
        // itself contains a link is left as literal brackets (which is
        // how a nested link's alt text keeps its [text](href) shape).
        const children = parseInline(link.text, refs, flat);
        if (flat) {
          flushText(i);
          for (const cn of children) nodes.push(cn);
          i = link.end;
          textStart = i;
          continue;
        }
        if (isImage || !containsLink(children)) {
          flushText(isImage ? i : i);
          nodes.push({ t: isImage ? 'image' : 'link', dest: link.dest, title: link.title, href: link.href, children });
          i = link.end;
          textStart = i;
          continue;
        }
      }
      i++;
    } else if (ch === '<') {
      const auto = tryAutolink(text, i);
      if (auto) {
        flushText(i);
        nodes.push(auto.node);
        i = auto.end;
        textStart = i;
        continue;
      }
      const html = tryInlineHtml(text, i);
      if (html) {
        flushText(i);
        nodes.push({ t: 'html', s: html.text });
        i = html.end;
        textStart = i;
        continue;
      }
      i++;
    } else if (ch === '*' || ch === '_' || ch === '~') {
      let n = 0;
      while (i + n < text.length && text[i + n] === ch) n++;
      // a '~' run of 3+ is not a strikethrough delimiter
      if (ch === '~' && n >= 3) { i += n; continue; }
      flushText(i);
      const runNode = { t: 'text', s: ch.repeat(n) };
      nodes.push(runNode);
      const before = i > 0 ? text[i - 1] : undefined;
      const after = i + n < text.length ? text[i + n] : undefined;
      const leftFlank = after !== undefined && !isSpace(after) &&
        (!isUnicodePunct(after) || before === undefined || isSpace(before) || isUnicodePunct(before));
      const rightFlank = before !== undefined && !isSpace(before) &&
        (!isUnicodePunct(before) || after === undefined || isSpace(after) || isUnicodePunct(after));
      let canOpen, canClose;
      if (ch === '_') {
        canOpen = leftFlank && (!rightFlank || isUnicodePunct(before));
        canClose = rightFlank && (!leftFlank || isUnicodePunct(after));
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      pushDelim(ch, runNode, n, canOpen, canClose);
      i += n;
      textStart = i;
    } else if (ch === '\n') {
      let k = i - 1;
      let spaces = 0;
      while (k >= textStart && text[k] === ' ') { spaces++; k--; }
      if (spaces >= 2) {
        flushText(i - spaces);
        nodes.push({ t: 'br' });
      } else {
        flushText(i);
        nodes.push({ t: 'softbr' });
      }
      i++;
      if (spaces >= 2) {
        // a hard break strips the next line's leading whitespace
        while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
      }
      textStart = i;
    } else if (ch === '@') {
      const email = tryGfmEmail(text, i);
      if (email) {
        // a scheme before the email makes the whole thing one autolink
        // (mailto:foo@bar.baz, xmpp:foo@bar.baz/txt)
        let linkStart = email.localStart;
        let linkEnd = email.end;
        let linkText = text.slice(email.localStart, email.end);
        let linkHref = 'mailto:' + linkText;
        const scheme = trySchemeBefore(text, email.localStart);
        if (scheme) {
          linkStart = scheme.start;
          if (scheme.scheme === 'xmpp') {
            // xmpp allows exactly one /resource segment after the email
            let extEnd = email.end;
            if (text[extEnd] === '/') {
              extEnd++;
              while (extEnd < text.length && !/[\s<>/]/.test(text[extEnd])) extEnd++;
            }
            linkText = stripUrlTail(text.slice(scheme.start, extEnd));
            linkEnd = scheme.start + linkText.length;
            linkHref = linkText;
          } else {
            // mailto and other schemes: the link ends at the email
            linkText = text.slice(scheme.start, email.end);
            linkEnd = scheme.start + linkText.length;
            linkHref = linkText;
          }
        }
        if (linkStart >= textStart) {
          flushText(linkStart);
        } else {
          // the link start extends into already-flushed nodes (e.g. a
          // '_' emphasis delimiter inside the local part, or a scheme
          // that was flushed as text): rewind those nodes
          let rewind = textStart - linkStart;
          let ok = true;
          while (rewind > 0) {
            const last = nodes[nodes.length - 1];
            if (!last || last.t !== 'text') { ok = false; break; }
            const di = delims.findIndex(d => d.node === last);
            if (di >= 0) {
              if (last.s.length > rewind) { ok = false; break; }
              const d = delims[di];
              if (d.prev) d.prev.next = d.next;
              if (d.next) d.next.prev = d.prev;
              delims.splice(di, 1);
              rewind -= last.s.length;
              nodes.pop();
            } else if (last.s.length <= rewind) {
              rewind -= last.s.length;
              nodes.pop();
            } else {
              last.s = last.s.slice(0, last.s.length - rewind);
              rewind = 0;
            }
          }
          if (!ok) { i++; continue; }
        }
        nodes.push({ t: 'link', auto: true, dest: linkHref, title: null, href: escapeText(encodeHref(linkHref)), children: [{ t: 'text', s: linkText }] });
        i = linkEnd;
        textStart = i;
        continue;
      }
      i++;
    } else if (ch === 'w' || ch === 'h' || ch === 'f' || ch === 'W' || ch === 'H' || ch === 'F') {
      const auto = tryGfmUrl(text, i);
      if (auto) {
        flushText(i);
        nodes.push(auto.node);
        i = auto.end;
        textStart = i;
        continue;
      }
      i++;
    } else {
      i++;
    }
  }
  flushText(text.length);
  processEmphasis(nodes, delims);
  return nodes;
}

function containsLink(nodes) {
  for (const n of nodes) {
    if (n.t === 'link' && !n.auto) return true;
    if (n.children && containsLink(n.children)) return true;
  }
  return false;
}

// Find the matching ] for the [ at `start`, with bracket-depth tracking.
// A ] inside an HTML tag's quoted attribute value does not count.
function findLinkTextEnd(text, start) {
  let depth = 0;
  let k = start + 1;
  while (k < text.length) {
    const ch = text[k];
    if (ch === '\\' && k + 1 < text.length) { k += 2; continue; }
    if (ch === '<') {
      // a <...> autolink swallows the ] inside it, so skip past it
      const auto = tryAutolink(text, k);
      if (auto) { k = auto.end; continue; }
      const html = tryInlineHtml(text, k);
      if (html) { k = html.end; continue; }
    }
    if (ch === '`') {
      let n = 0;
      while (k + n < text.length && text[k + n] === '`') n++;
      let j = k + n;
      let found = -1;
      while (j < text.length) {
        if (text[j] === '`') {
          let m = 0;
          while (j + m < text.length && text[j + m] === '`') m++;
          if (m === n) { found = j; break; }
          j += m;
        } else j++;
      }
      if (found === -1) return -1;
      k = found + n;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      if (depth === 0) return k;
      depth--;
    }
    k++;
  }
  return -1;
}

function tryParseLink(text, start, refs) {
  const close = findLinkTextEnd(text, start);
  if (close === -1) return null;
  const labelText = text.slice(start + 1, close);
  let p = close + 1;
  let dest = null;
  let title = null;
  let end = -1;
  if (text[p] === '(') {
    // inline link; if the target is invalid, fall back to a shortcut
    // reference link for [labelText]
    p++;
    const parsed = parseInlineLinkTarget(text, p);
    if (parsed) {
      dest = parsed.dest;
      title = parsed.title;
      end = parsed.end;
    } else if (!labelHasBracket(labelText)) {
      const ref = refs.get(normalizeLabel(labelText));
      if (!ref) return null;
      dest = ref.dest;
      title = ref.title;
      end = close + 1;
    } else {
      return null;
    }
  } else if (text[p] === '[') {
    // full or collapsed reference
    const close2 = findLinkTextEnd(text, p);
    if (close2 === -1) return null;
    const label = close2 === p + 1 ? labelText : text.slice(p + 1, close2);
    if (labelHasBracket(label)) return null;
    const ref = refs.get(normalizeLabel(label));
    if (!ref) return null;
    dest = ref.dest;
    title = ref.title;
    end = close2 + 1;
  } else {
    // shortcut reference
    if (labelHasBracket(labelText)) return null;
    const ref = refs.get(normalizeLabel(labelText));
    if (!ref) return null;
    dest = ref.dest;
    title = ref.title;
    end = close + 1;
  }
  return { text: labelText, dest, title, href: cleanHref(dest), end };
}

// Parse an inline link target starting just after '('. Returns
// { dest, title, end } (end = index after the closing ')') or null.
function parseInlineLinkTarget(text, p) {
  let i = p;
  // skip whitespace/newlines
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n')) i++;
  if (i >= text.length) return null;
  let dest = '';
  if (text[i] === '<') {
    // scan for the closing '>', skipping escaped characters (an
    // escaped '>' does not close the destination)
    let gt = -1;
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\\' && j + 1 < text.length) { j++; continue; }
      if (text[j] === '>') { gt = j; break; }
      if (text[j] === '\n' || text[j] === '<') return null;
    }
    if (gt === -1) return null;
    dest = text.slice(i + 1, gt);
    i = gt + 1;
  } else {
    // bare destination: balanced parens, no whitespace
    let depth = 0;
    let j = i;
    while (j < text.length) {
      const ch = text[j];
      if (ch === ' ' || ch === '\t' || ch === '\n') break;
      if (ch === '\\' && j + 1 < text.length) { j += 2; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    if (j === i) {
      // empty destination: [link]() is a link with href=""
      dest = '';
    } else {
      dest = text.slice(i, j);
    }
    i = j;
  }
  dest = unescape(dest);
  // optional title
  let title = null;
  let k = i;
  while (k < text.length && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
  if (k < text.length && (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
    const q = text[k];
    const closeQ = q === '(' ? ')' : q;
    let j = k + 1;
    let ok = false;
    while (j < text.length) {
      const ch = text[j];
      if (ch === '\\' && j + 1 < text.length) { j += 2; continue; }
      if (ch === closeQ) { ok = true; break; }
      if (q === '(' && ch === '(') break;
      j++;
    }
    if (!ok) return null;
    title = text.slice(k + 1, j);
    title = unescape(title);
    i = j + 1;
    k = i;
    while (k < text.length && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
  }
  if (text[k] !== ')') return null;
  return { dest, title, end: k + 1 };
}

function tryAutolink(text, i) {
  const rest = text.slice(i);
  let m = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}):([^<>\s]*)>/.exec(rest);
  if (m) {
    const url = m[1] + ':' + m[2];
    return {
      node: { t: 'link', auto: true, dest: url, title: null, href: escapeText(encodeHref(url)), children: [{ t: 'text', s: url }] },
      end: i + m[0].length,
    };
  }
  m = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/.exec(rest);
  if (m) {
    const email = m[1];
    return {
      node: { t: 'link', auto: true, dest: 'mailto:' + email, title: null, href: 'mailto:' + escapeText(email), children: [{ t: 'text', s: email }] },
      end: i + m[0].length,
    };
  }
  return null;
}

function tryInlineHtml(text, i) {
  const rest = text.slice(i);
  let m;
  if (rest.startsWith('<!--')) {
    // <!--> and <!---> are complete (empty) comments on their own
    if (rest.startsWith('<!-->')) return { text: '<!-->', end: i + 5 };
    if (rest.startsWith('<!--->')) return { text: '<!--->', end: i + 6 };
    const end = rest.indexOf('-->', 4);
    if (end === -1) return null;
    return { text: rest.slice(0, end + 3), end: i + end + 3 };
  }
  if (rest.startsWith('<?')) {
    const end = rest.indexOf('?>', 2);
    if (end === -1) return null;
    return { text: rest.slice(0, end + 2), end: i + end + 2 };
  }
  if (rest.startsWith('<![CDATA[')) {
    const end = rest.indexOf(']]>', 9);
    if (end === -1) return null;
    return { text: rest.slice(0, end + 3), end: i + end + 3 };
  }
  if (/^<![A-Za-z]/.test(rest)) {
    const end = rest.indexOf('>');
    if (end === -1) return null;
    return { text: rest.slice(0, end + 1), end: i + end + 1 };
  }
  // open/closing tag (quoted attribute values may contain '>' and
  // newlines, so a scanner is used instead of a regex)
  const tagEnd = scanHtmlTag(text, i);
  if (tagEnd !== -1) {
    return { text: text.slice(i, tagEnd), end: tagEnd };
  }
  return null;
}

// GFM extended autolink: www. or http/https/ftp URL starting at i.
function tryGfmUrl(text, i) {
  const rest = text.slice(i);
  // www. is lowercase-only; the scheme part is case-insensitive
  let m = /^(www\.)([^\s<]*)/.exec(rest) || /^(https?:\/\/|ftp:\/\/)([^\s<]*)/i.exec(rest);
  if (!m) return null;
  // must not be preceded by a word character (checked by caller context:
  // we only call this when the previous char is not alphanumeric)
  let url = m[0];
  // strip trailing punctuation
  url = stripUrlTail(url);
  if (url.length <= m[1].length) return null;
  const schemeLower = m[1].toLowerCase();
  const href = schemeLower === 'www.' ? 'http://' + url : url;
  return {
    node: { t: 'link', auto: true, dest: href, title: null, href: escapeText(encodeHref(href)), children: [{ t: 'text', s: url }] },
    end: i + url.length,
  };
}

function stripUrlTail(url) {
  // strip trailing punctuation ?, !, ., ,, :, *, _, ~
  let end = url.length;
  while (end > 0 && '?!,.:*_~'.includes(url[end - 1])) end--;
  // strip a trailing ; (a trailing &word; entity-like suffix is
  // stripped whole, even for valid entity names)
  while (end > 0 && url[end - 1] === ';') {
    const amp = url.lastIndexOf('&', end - 2);
    if (amp !== -1 && /^&\w+;$/.test(url.slice(amp, end))) end = amp;
    else end--;
  }
  // balance parens: strip trailing ) while there are more ) than (
  while (end > 0 && url[end - 1] === ')') {
    const sub = url.slice(0, end);
    const opens = (sub.match(/\(/g) || []).length;
    const closes = (sub.match(/\)/g) || []).length;
    if (closes <= opens) break;
    end--;
  }
  return url.slice(0, end);
}

// A scheme autolink immediately before the email local part at pos,
// e.g. 'mailto:' in 'mailto:foo@bar.baz'. Returns {start, scheme} or null.
function trySchemeBefore(text, pos) {
  if (pos < 2 || text[pos - 1] !== ':') return null;
  let s = pos - 2;
  while (s >= 0 && /[a-zA-Z0-9+.-]/.test(text[s])) s--;
  s++;
  const scheme = text.slice(s, pos - 1);
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}$/.test(scheme)) return null;
  if (s > 0 && /[a-zA-Z0-9+.-]/.test(text[s - 1])) return null;
  return { start: s, scheme };
}

// GFM extended autolink: bare email with the @ at position i.
// Scans the local part back to the start of the text (the caller
// rewinds any already-flushed nodes that fall inside the local part).
function tryGfmEmail(text, i) {
  let ls = i - 1;
  while (ls >= 0 && EMAIL_LOCAL_CHARS.includes(text[ls])) ls--;
  ls++;
  if (ls >= i) return null;
  // if the local part's first char is backslash-escaped, the email is
  // not a bare autolink (e.g. <foo\+@bar.example.com>)
  if (ls > 0 && text[ls - 1] === '\\') return null;
  const rest = text.slice(i + 1);
  const m = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/.exec(rest);
  if (!m) return null;
  let domain = m[0];
  // strip trailing punctuation from the domain
  while (domain.length && '?!,.:;'.includes(domain[domain.length - 1])) domain = domain.slice(0, -1);
  if (!domain.includes('.')) return null;
  // a trailing '-' or '_' right after the domain invalidates the
  // autolink entirely (a.b-c_d@a.b- is plain text, not a link)
  const afterDomain = text[i + 1 + domain.length];
  if (afterDomain === '-' || afterDomain === '_') return null;
  const email = text.slice(ls, i) + '@' + domain;
  return {
    localStart: ls,
    node: { t: 'link', auto: true, dest: 'mailto:' + email, title: null, href: 'mailto:' + escapeText(email), children: [{ t: 'text', s: email }] },
    end: i + 1 + domain.length,
  };
}

// Process emphasis / strong / strikethrough delimiters (CommonMark
// delimiter-stack algorithm).
function processEmphasis(nodes, delims) {
  if (!delims.length) return;
  const openersBottom = new Map();
  let current = delims[0];
  function removeDelim(d) {
    if (d.prev) d.prev.next = d.next;
    if (d.next) d.next.prev = d.prev;
    if (current === d) current = d.next;
    const idx = delims.indexOf(d);
    if (idx >= 0) delims.splice(idx, 1);
  }
  while (current) {
    if (current.canClose) {
      let opener = current.prev;
      let found = null;
      // the "bottom" below which no opener need be sought depends on
      // the closer's length mod 3, because the odd-match rule (which
      // can block a match) depends on opener.num + closer.num
      const bottom = openersBottom.get(current.char + ':' + (current.num % 3));
      while (opener && opener !== bottom) {
        const oddMatch = (opener.canOpen && opener.canClose) || (current.canOpen && current.canClose);
        // the odd-match rule does not apply when both runs are
        // multiples of 3
        const bothMult3 = (opener.num % 3 === 0) && (current.num % 3 === 0);
        if (opener.char === current.char && opener.canOpen &&
          !(oddMatch && (opener.num + current.num) % 3 === 0 && !bothMult3)) {
          found = opener;
          break;
        }
        opener = opener.prev;
      }
      if (!found) {
        openersBottom.set(current.char + ':' + (current.num % 3), current.prev);
        const next = current.next;
        if (!current.canOpen) removeDelim(current);
        current = next;
      } else {
        let use;
        if (current.char === '~') use = Math.min(2, found.num, current.num);
        else use = (found.num >= 2 && current.num >= 2) ? 2 : 1;
        found.num -= use;
        current.num -= use;
        found.node.s = found.node.s.slice(0, found.node.s.length - use);
        current.node.s = current.node.s.slice(use);
        const tag = current.char === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
        const oi = nodes.indexOf(found.node);
        const ci = nodes.indexOf(current.node);
        const children = nodes.slice(oi + 1, ci);
        nodes.splice(oi + 1, ci - oi - 1, { t: tag, children });
        // delimiters that fell inside the new emphasis node can no
        // longer match a closer outside it
        if (children.length) {
          const childSet = new Set(children);
          for (const d of [...delims]) {
            if (childSet.has(d.node)) removeDelim(d);
          }
        }
        if (found.num === 0) removeDelim(found);
        if (current.num === 0) {
          const next = current.next;
          removeDelim(current);
          current = next;
        }
      }
    } else {
      current = current.next;
    }
  }
  // drop emptied delimiter text nodes
  for (let k = nodes.length - 1; k >= 0; k--) {
    if (nodes[k].t === 'text' && nodes[k].s === '') nodes.splice(k, 1);
  }
}

// ---------------------------------------------------------------- rendering

function renderBlocks(children, doc) {
  let out = '';
  for (const b of children) out += renderBlock(b, doc);
  return out;
}

function renderBlock(b, doc) {
  switch (b.type) {
    case 'paragraph':
      return '<p>' + renderInline(parseInline(b.lines.join('\n'), doc.refs)) + '</p>\n';
    case 'heading':
      // a heading's content is trimmed (a setext heading keeps its
      // paragraph's leading spaces on the first line and trailing
      // whitespace on the last line unless trimmed here)
      return '<h' + b.level + '>' + renderInline(parseInline(b.lines.join('\n').replace(/^[ \t]+|[ \t]+$/g, ''), doc.refs)) + '</h' + b.level + '>\n';
    case 'code': {
      let out = '<pre><code';
      if (b.fenced && b.info) out += ' class="language-' + escapeText(unescape(b.info).split(/[ \t]/)[0]) + '"';
      out += '>';
      const content = b.lines.length ? b.lines.join('\n') + (b.lines[b.lines.length - 1] === '' ? '' : '\n') : '';
      out += escapeFull(content);
      out += '</code></pre>\n';
      return out;
    }
    case 'html':
      return b.text;
    case 'thematic_break':
      return '<hr>\n';
    case 'blockquote':
      return '<blockquote>\n' + renderBlocks(b.children, doc) + '</blockquote>\n';
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const startAttr = (b.ordered && b.start !== 1) ? ' start="' + b.start + '"' : '';
      let out = '<' + tag + startAttr + '>\n';
      for (const item of b.children) out += renderBlock(item, doc);
      out += '</' + tag + '>\n';
      return out;
    }
    case 'list_item': {
      let out = '<li>';
      const children = b.children;
      // task list marker on the first paragraph
      const first = children[0];
      let checkbox = '';
      if (first && first.type === 'paragraph' && first.lines.length) {
        const m = /^\[([ xX])\] /.exec(first.lines[0]);
        if (m) {
          checkbox = m[1] === ' '
            ? '<input disabled="" type="checkbox"> '
            : '<input checked="" disabled="" type="checkbox"> ';
          first.lines[0] = first.lines[0].slice(4);
        }
      }
      const tight = b.parent.tight;
      for (let ci = 0; ci < children.length; ci++) {
        const child = children[ci];
        if (tight && child.type === 'paragraph') {
          if (ci === 0 && checkbox) out += checkbox;
          out += renderInline(parseInline(child.lines.join('\n'), doc.refs));
        } else if (ci === 0 && checkbox && child.type === 'paragraph') {
          // loose list: the checkbox goes inside the <p>
          out += '<p>' + checkbox + renderInline(parseInline(child.lines.join('\n'), doc.refs)) + '</p>\n';
        } else {
          out += renderBlock(child, doc);
        }
      }
      out += '</li>\n';
      return out;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < b.header.length; i++) {
        const a = b.aligns[i] ? ' align="' + b.aligns[i] + '"' : '';
        out += '<th' + a + '>' + renderInline(parseInline(b.header[i], doc.refs)) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let i = 0; i < b.header.length; i++) {
            const cell = row[i] !== undefined ? row[i] : '';
            const a = b.aligns[i] ? ' align="' + b.aligns[i] + '"' : '';
            out += '<td' + a + '>' + renderInline(parseInline(cell, doc.refs)) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
    default:
      return '';
  }
}

function renderInline(nodes) {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
        out += escapeText(n.s);
        break;
      case 'code':
        out += '<code>' + escapeFull(n.s) + '</code>';
        break;
      case 'em':
        out += '<em>' + renderInline(n.children) + '</em>';
        break;
      case 'strong':
        out += '<strong>' + renderInline(n.children) + '</strong>';
        break;
      case 'del':
        out += '<del>' + renderInline(n.children) + '</del>';
        break;
      case 'br':
        out += '<br>';
        break;
      case 'softbr':
        out += '\n';
        break;
      case 'html':
        out += n.s;
        break;
      case 'link': {
        const href = n.href !== undefined ? n.href : cleanHref(n.dest);
        out += '<a href="' + href + '"';
        if (n.title) out += ' title="' + cleanTitle(n.title) + '"';
        out += '>' + renderInline(n.children) + '</a>';
        break;
      }
      case 'image': {
        const src = cleanHref(n.dest);
        const alt = plainText(n.children);
        out += '<img src="' + src + '" alt="' + escapeText(alt) + '"';
        if (n.title) out += ' title="' + cleanTitle(n.title) + '"';
        out += '>';
        break;
      }
    }
  }
  return out;
}

// Plain-text form of inline nodes (for image alt text).
function plainText(nodes) {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
      case 'code':
      case 'html':
        out += n.s;
        break;
      case 'softbr':
        out += '\n';
        break;
      case 'br':
        out += '\n';
        break;
      case 'em':
      case 'strong':
      case 'del':
      case 'link':
      case 'image':
        out += plainText(n.children);
        break;
    }
  }
  return out;
}
