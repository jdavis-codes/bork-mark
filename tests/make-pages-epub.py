# An EPUB with long chapter titles and a page list labelled "page N.", as some
# publishers do: for search results, which shorten the title and show "p. N".
# Usage: python3 make-pages-epub.py pages.epub
import random, zipfile, sys
rng = random.Random(5)
W = "the quick brown fox jumps over a lazy dog while reading old books under quiet lamps and thinking about a test".split()
para = lambda: " ".join((" ".join(rng.choice(W) for _ in range(rng.randint(8, 16)))).capitalize() + "." for _ in range(4))
heads = ['12 Problem Management Putting Skills Together for Everyday Life', 'Readiness and Setting the Stage for College and Work', 'Short']
z = zipfile.ZipFile(sys.argv[1], 'w')
z.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
z.writestr('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
z.writestr('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Pages</dc:title><dc:creator>A</dc:creator></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
           + ''.join('<item id="c%d" href="c%d.xhtml" media-type="application/xhtml+xml"/>' % (i, i) for i in range(3)) + '</manifest><spine>' + ''.join('<itemref idref="c%d"/>' % i for i in range(3)) + '</spine></package>')
pages = []
for i, h in enumerate(heads):
    body = ''
    for k in range(6):
        n = 60 + i * 6 + k
        pages.append((i, n))
        body += '<span epub:type="pagebreak" id="p%d" title="%d"/><p>%s</p>' % (n, n, para())
    z.writestr('OEBPS/c%d.xhtml' % i, '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>x</title></head><body><h1 id="h%d">%s</h1>%s</body></html>' % (i, h, body))
z.writestr('OEBPS/nav.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>'
           + ''.join('<li><a href="c%d.xhtml#h%d">%s</a></li>' % (i, i, h) for i, h in enumerate(heads)) + '</ol></nav><nav epub:type="page-list"><ol>'
           + ''.join('<li><a href="c%d.xhtml#p%d">page %d.</a></li>' % (i, n, n) for i, n in pages) + '</ol></nav></body></html>')
z.close()
