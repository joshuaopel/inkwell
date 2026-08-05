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

// Minimal, safe prose-markdown -> XHTML. Blank lines split paragraphs;
// **bold** and *italic* and _italic_ are honored. Everything else is escaped.
function proseToXhtml(md) {
  const blocks = String(md || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks
    .map((b) => {
      let t = esc(b).replace(/\n/g, '<br/>');
      t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/(^|[^*])\*(?!\*)(.+?)\*/g, '$1<em>$2</em>');
      t = t.replace(/_(.+?)_/g, '<em>$1</em>');
      // Center scene breaks written as *** or ---
      if (/^(\*{3}|-{3}|#)$/.test(b)) return '<p class="sep">* * *</p>';
      return `<p>${t}</p>`;
    })
    .join('\n');
}

const CSS = `body{font-family:Georgia,'Times New Roman',serif;line-height:1.5;margin:5%;}
h1{text-align:center;margin:3em 0 1.5em;font-weight:normal;font-size:1.6em;}
p{margin:0;text-indent:1.4em;text-align:justify;}
p.first{text-indent:0;}
p.sep{text-align:center;text-indent:0;margin:1.4em 0;letter-spacing:0.4em;}
.title-page{text-align:center;margin-top:30%;}
.title-page h1{font-size:2.2em;}
.title-page .author{margin-top:2em;font-size:1.2em;font-style:italic;}`;

function chapterXhtml(title, bodyHtml) {
  // give the first paragraph a no-indent class
  const body = bodyHtml.replace(/^<p>/, '<p class="first">');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><meta charset="utf-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><section epub:type="chapter"><h1>${esc(title)}</h1>
${body}
</section></body></html>`;
}

export async function buildEpub({ meta, outline }) {
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
  oebps.file('style.css', CSS);

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

  chapters.forEach((ch, i) => {
    const fname = `chap-${i + 1}.xhtml`;
    oebps.file(fname, chapterXhtml(ch.title || `Chapter ${i + 1}`, proseToXhtml(ch.content)));
    manifestItems.push(`<item id="chap${i + 1}" href="${fname}" media-type="application/xhtml+xml"/>`);
    spineItems.push(`chap${i + 1}`);
    navList.push(`<li><a href="${fname}">${esc(ch.title || `Chapter ${i + 1}`)}</a></li>`);
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
${manifestItems.join('\n')}
</manifest>
<spine>
${spineItems.map((id) => `<itemref idref="${id}"/>`).join('\n')}
</spine>
</package>`
  );

  return zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip' });
}
