// KDP-ready EPUB 3 generator. An EPUB is just a ZIP with a specific layout;
// we build it by hand with JSZip so there's no fragile third-party epub lib.
// The result uploads directly to Kindle Direct Publishing.

import JSZip from 'jszip';

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Minimal, safe prose-markdown -> XHTML blocks. Blank lines split paragraphs;
// **bold** and *italic* and _italic_ are honored. Everything else is escaped.
// Returns one string per block so art can be slotted between paragraphs.
function proseBlocks(md, sceneBreak) {
  const blocks = String(md || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.map((b, i) => {
    if (/^(\*{3}|-{3}|#{1,3}|·{3})$/.test(b)) {
      return sceneBreak === '(blank line)'
        ? '<p class="sep">&#160;</p>'
        : `<p class="sep">${esc(sceneBreak || '* * *')}</p>`;
    }
    let t = esc(b).replace(/\n/g, '<br/>');
    t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*(?!\*)(.+?)\*/g, '$1<em>$2</em>');
    t = t.replace(/_(.+?)_/g, '<em>$1</em>');
    return `<p${i === 0 ? ' class="first"' : ''}>${t}</p>`;
  });
}

const ROMAN = [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
const WORDS = ['Zero','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen','Twenty','Twenty-one','Twenty-two','Twenty-three','Twenty-four','Twenty-five','Twenty-six','Twenty-seven','Twenty-eight','Twenty-nine','Thirty'];

function chapterLabel(design, n) {
  const o = design.opener;
  if (o.numbering === 'none') return '';
  const body = o.numbering === 'roman'
    ? ROMAN.reduce((acc, [k, s]) => { while (acc.v >= k) { acc.out += s; acc.v -= k; } return acc; }, { v: n, out: '' }).out
    : o.numbering === 'words' ? (WORDS[n] || n) : n;
  return `${o.label ? o.label + ' ' : ''}${body}`;
}

// The page design, translated for e-readers. Trim size, margins and paper
// colour are deliberately left out: an EPUB reflows to whatever device it's on,
// and forcing a background fights the reader's own theme. What carries over is
// everything about the type — face, size, leading, indents, drop caps, scene
// breaks and chapter openers.
function buildCss(design, embeddedFont) {
  const t = design.type, o = design.opener;
  const dropcap = (t.dropcapLines * t.leading).toFixed(2);
  return `${embeddedFont ? `@font-face{font-family:"InkwellBody";src:url("${embeddedFont.href}");font-weight:normal;font-style:normal;}\n` : ''}body{font-family:${embeddedFont ? '"InkwellBody",' : ''}${t.stack};line-height:${t.leading};margin:5%;${t.tracking ? `letter-spacing:${t.tracking}em;` : ''}}
h1{text-align:${o.align === 'left' ? 'left' : 'center'};margin:${(o.drop * 6).toFixed(1)}em 0 1.2em;font-weight:${o.style === 'modern' ? '600' : 'normal'};font-size:${o.style === 'plain' ? '1.2' : o.style === 'modern' ? '1.9' : '1.6'}em;}
h1 .num{display:block;font-size:.48em;letter-spacing:.2em;text-transform:uppercase;margin-bottom:.9em;font-weight:normal;}
h1 .orn{display:block;font-size:.6em;letter-spacing:.3em;margin-top:.7em;font-weight:normal;}
h1 .rule{display:block;width:2.4em;border-top:1px solid currentColor;margin:.7em ${o.align === 'left' ? '0' : 'auto'};}
p{margin:0 0 ${t.spacing}em;text-indent:${t.indent}em;text-align:${t.align === 'left' ? 'left' : 'justify'};${t.hyphens ? 'hyphens:auto;-webkit-hyphens:auto;' : ''}}
p.first{text-indent:0;}
${t.firstLine === 'dropcap' ? `p.first::first-letter{float:left;font-size:${dropcap}em;line-height:.78;padding:.04em .09em 0 0;}` : ''}
${t.firstLine === 'raised' ? `p.first::first-letter{font-size:2.3em;line-height:.8;vertical-align:-.14em;}` : ''}
${t.firstLine === 'smallcaps' ? `p.first::first-line{font-variant:small-caps;letter-spacing:.08em;}` : ''}
p.sep{text-align:center;text-indent:0;margin:1.2em 0;letter-spacing:0.34em;}
figure{margin:0;padding:0;}
figure img{max-width:100%;height:auto;display:block;}
figure figcaption{font-size:.72em;text-align:center;text-indent:0;margin-top:.4em;font-style:italic;}
figure.side-left{float:left;width:45%;margin:.2em 1em .8em 0;}
figure.side-right{float:right;width:45%;margin:.2em 0 .8em 1em;}
figure.side-center{width:70%;margin:1em auto;}
figure.side-full,figure.side-bleed{width:100%;margin:1em 0;}
.title-page{text-align:center;margin-top:25%;}
.title-page h1{font-size:2.2em;margin-top:0;}
.title-page .author{margin-top:2em;font-size:1.2em;font-style:italic;}`;
}

function chapterXhtml(title, headingHtml, bodyHtml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><meta charset="utf-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><section epub:type="chapter">${headingHtml}
${bodyHtml}
</section></body></html>`;
}

const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const FONT_MIME = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' };

export async function buildEpub({ meta, outline, design, art, assets = [], readAsset }) {
  const zip = new JSZip();
  const bookId = meta.id;
  const uuid = `urn:uuid:${bookId}`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  // 1. mimetype — MUST be first and stored uncompressed.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  // 2. container
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
  );

  const oebps = zip.folder('OEBPS');

  // Pull in every asset the book actually uses: art that's placed somewhere,
  // plus the body font if it was uploaded rather than chosen from the list.
  const placements = (art?.placements || []).filter((p) => assets.some((a) => a.id === p.assetId));
  const extraItems = [];
  const assetHref = new Map();

  async function embed(asset, folder) {
    if (assetHref.has(asset.id) || !readAsset) return assetHref.get(asset.id);
    const bytes = await readAsset(asset.id).catch(() => null);
    if (!bytes) return null;
    const ext = (asset.file.match(/\.[a-z0-9]+$/i) || ['.bin'])[0].toLowerCase();
    const mime = (folder === 'fonts' ? FONT_MIME : IMG_MIME)[ext] || asset.mime;
    if (!mime) return null;
    const href = `${folder}/${asset.id}${ext}`;
    oebps.file(href, bytes);
    extraItems.push(`<item id="${folder}-${asset.id}" href="${href}" media-type="${mime}"/>`);
    assetHref.set(asset.id, href);
    return href;
  }

  for (const p of placements) {
    const a = assets.find((x) => x.id === p.assetId);
    if (a) await embed(a, 'art');
  }

  let embeddedFont = null;
  if (typeof design?.type?.fontId === 'string' && design.type.fontId.startsWith('upload:')) {
    const fontAsset = assets.find((a) => a.id === design.type.fontId.slice(7));
    if (fontAsset) {
      const href = await embed(fontAsset, 'fonts');
      if (href) embeddedFont = { href };
    }
  }

  oebps.file('style.css', buildCss(design, embeddedFont));

  // 3. title page
  oebps.file(
    'title.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><meta charset="utf-8"/><title>${esc(meta.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><div class="title-page"><h1>${esc(meta.title)}</h1>${meta.author ? `<div class="author">${esc(meta.author)}</div>` : ''}</div></body></html>`
  );

  const chapters = (outline.chapters || []).filter((c) => (c.content || '').trim());
  const manifestItems = [];
  const spineItems = ['title'];
  const navList = [];

  // Chapter numbering follows the whole outline, so skipping an unwritten
  // chapter doesn't renumber the ones around it.
  const numberOf = new Map((outline.chapters || []).map((c, i) => [c.id, i + 1]));

  chapters.forEach((ch, i) => {
    const fname = `chap-${i + 1}.xhtml`;
    const title = ch.title || `Chapter ${i + 1}`;
    const label = chapterLabel(design, numberOf.get(ch.id) || i + 1);
    const o = design.opener;
    const heading = `<h1>${label ? `<span class="num">${esc(label)}</span>` : ''}` +
      `${o.style === 'rule' ? '<span class="rule"></span>' : ''}${esc(title)}` +
      `${o.style === 'classic' || o.style === 'ornament' ? `<span class="orn">${esc(o.ornament)}</span>` : ''}</h1>`;

    // Slot the placed art in between the paragraphs it was anchored to.
    const blocks = proseBlocks(ch.content, design.furniture.sceneBreak);
    const mine = placements.filter((p) => p.chapterId === ch.id).sort((a, b) => a.para - b.para);
    const out = [];
    blocks.forEach((b, bi) => {
      for (const p of mine.filter((x) => (bi === 0 ? x.para <= 0 : x.para === bi))) {
        const href = assetHref.get(p.assetId);
        if (!href) continue;
        const alt = p.caption || assets.find((a) => a.id === p.assetId)?.name || '';
        out.push(`<figure class="side-${p.side}" style="width:${p.width}%"><img src="${href}" alt="${esc(alt)}"/>` +
          `${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ''}</figure>`);
      }
      out.push(b);
    });
    for (const p of mine.filter((x) => x.para >= blocks.length && blocks.length)) {
      const href = assetHref.get(p.assetId);
      if (href) out.push(`<figure class="side-${p.side}" style="width:${p.width}%"><img src="${href}" alt="${esc(p.caption || '')}"/>${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ''}</figure>`);
    }

    oebps.file(fname, chapterXhtml(title, heading, out.join('\n')));
    manifestItems.push(`<item id="chap${i + 1}" href="${fname}" media-type="application/xhtml+xml"/>`);
    spineItems.push(`chap${i + 1}`);
    navList.push(`<li><a href="${fname}">${esc(title)}</a></li>`);
  });

  // 4. nav (EPUB3 table of contents)
  oebps.file(
    'nav.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en"><head><meta charset="utf-8"/><title>Contents</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${navList.join('')}</ol></nav></body></html>`
  );

  // 5. OPF package
  oebps.file(
    'content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${uuid}</dc:identifier>
<dc:title>${esc(meta.title)}</dc:title>
<dc:creator>${esc(meta.author || 'Unknown')}</dc:creator>
<dc:language>en</dc:language>
${meta.genre ? `<dc:subject>${esc(meta.genre)}</dc:subject>` : ''}
<meta property="dcterms:modified">${now}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
${extraItems.join('\n')}
${manifestItems.join('\n')}
</manifest>
<spine>
${spineItems.map((id) => `<itemref idref="${id}"/>`).join('\n')}
</spine>
</package>`
  );

  return zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip' });
}
