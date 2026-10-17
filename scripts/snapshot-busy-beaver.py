#!/usr/bin/env python3
"""Export the locally served BB6 website, without copying the working repository.

Usage: python3 scripts/snapshot-busy-beaver.py /path/to/bb6-hunt
Requires its read-only local web server on port 8765. No remote credentials.
Large simulation dumps, compiled proofs, hidden files, and coordination/config
files are deliberately outside the public snapshot. Rendered documents keep
working links; the export never needs a Python server in production.
"""
import collections, datetime, html, json, pathlib, re, shutil, sys, urllib.parse, urllib.request
from html.parser import HTMLParser
ROOT = pathlib.Path(sys.argv[1]).resolve()
OUT = pathlib.Path('public/busy-beaver')
BASE = 'http://localhost:8765/'
PREFIX = '/busy-beaver/'
ALLOWED = {'dashboard', 'machines', 'learn', 'reports', 'tools'}
EXT = {'.html','.css','.js','.mjs','.json','.svg','.png','.jpg','.jpeg','.webp','.md','.v','.py','.sh','.c','.h','.txt','.pdf'}
RENDER = {'.md','.v','.py','.sh','.c','.h'}
MAX = 3_000_000
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
queue = collections.deque(['dashboard/index.html','tools/explorer/index.html'])
seen = set(); pages = {}; assets = {}; omitted = {}; links = {}
class Parser(HTMLParser):
    def __init__(self): super().__init__(convert_charrefs=False); self.urls=[]
    def handle_starttag(self,tag,attrs):
        for k,v in attrs:
            if k in {'href','src','poster'} and v: self.urls.append(v)
def local(value, base):
    u = urllib.parse.urlsplit(urllib.parse.urljoin(BASE+base, html.unescape(value)))
    if u.netloc not in {'localhost:8765','bb6.forbiddenweights.com'}: return None
    p = urllib.parse.unquote(u.path).lstrip('/')
    return p,u

def safe(p):
    f=ROOT/p
    return bool(p) and p.split('/')[0] in ALLOWED and not any(x.startswith('.') or x in {'node_modules','__pycache__','coord'} for x in pathlib.Path(p).parts) and f.resolve().is_relative_to(ROOT) and not f.is_symlink() and 'serve_access' not in p

def target(p):
    if (ROOT/p).is_dir() or p.endswith('/'): return p.rstrip('/')+'/index.html'
    return p+'.html' if pathlib.Path(p).suffix in RENDER else p

# JS imports and worker entrypoints are not discoverable from HTML anchors.
for folder in ['core','engine','ui']:
    queue.extend(str(p.relative_to(ROOT)) for p in (ROOT/'tools/explorer'/folder).rglob('*.mjs'))
queue.extend('tools/vizref/lib/'+name for name in ['bbchallenge_tm.mjs','canvas.mjs','blaze_port.mjs'])
queue.extend(['tools/explorer/machines.json','tools/explorer/presets.json','dashboard/data.json','dashboard/kills.json'])
while queue:
    p=queue.popleft()
    if p in seen: continue
    seen.add(p)
    if not safe(p): omitted[p]='Not included in this public snapshot.'; continue
    f=ROOT/p
    if f.is_dir():
        if (f/'index.html').is_file(): queue.append(p.rstrip('/')+'/index.html');continue
        children=[x for x in sorted(f.iterdir()) if not x.name.startswith('.') and (x.is_file() and x.suffix in {'.html','.md','.v','.png','.svg'}) and safe(str(x.relative_to(ROOT)))]
        body='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Files</title></head><body><h1>Files</h1><ul>'+''.join('<li><a href="'+html.escape(x.name+('/' if x.is_dir() else ''))+'">'+html.escape(x.name)+'</a></li>' for x in children)+'</ul></body></html>'
        # Directory pages should resolve child links from the directory itself.
        p=p.rstrip('/')+'/index.html'
    elif not f.is_file(): omitted[p]='This file was unavailable when the snapshot was captured.'; continue
    elif f.suffix not in EXT or f.stat().st_size>MAX:
        omitted[p]='Raw simulation dumps and large build artifacts are not included in this static snapshot.';continue
    elif f.suffix in RENDER:
        try:
            with urllib.request.urlopen(BASE+urllib.parse.quote(p), timeout=30) as r: body=r.read().decode()
        except Exception: omitted[p]='This document could not be exported.';continue
    elif f.suffix=='.html': body=f.read_text()
    else:
        assets[p]=f.read_bytes(); continue
    parser=Parser();parser.feed(body)
    for value in parser.urls:
        item=local(value,p)
        if item: queue.append(item[0])
    pages[p]=body
    if len(pages)%250==0: print('Exported',len(pages),'pages',flush=True)
    if len(seen)>12000: raise RuntimeError('Unexpected crawl expansion')
print('Captured',len(pages),'pages and',len(assets),'assets;',len(omitted),'excluded or unavailable references',flush=True)
# Make omitted files honest, useful destinations, not silent 404s.
for p,reason in omitted.items():
    if not p or not safe(p): continue
    pages[p]='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Snapshot file</title></head><body><main style="max-width:60rem;margin:4rem auto;padding:1rem;font:16px/1.6 system-ui"><h1>File not included</h1><p>'+html.escape(reason)+'</p><p><code>'+html.escape(p)+'</code></p><p><a href="'+PREFIX+'dashboard/index.html">Back to dashboard</a></p></main></body></html>'
# HTML response routes must end in .html on static hosting, including placeholders.
def destination(p):
    if p in omitted:return p.rstrip('/')+'/index.html' if (ROOT/p).is_dir() else p+'.html'
    return target(p)

notice='<aside style="padding:9px 18px;background:#e8eff3;color:#23323c;font:13px/1.5 system-ui;border-bottom:1px solid #aebbc4;position:relative;z-index:10">Static snapshot · '+stamp+' · <a style="color:inherit;text-decoration:underline" href="/work/busycoq/">Back to portfolio</a>. Statuses reflect the capture date.</aside>'
def rewrite(m,base):
    attr,quote,value=m.group(1,2,3)
    if value.startswith(PREFIX): return m.group(0)
    item=local(value,base)
    if not item:return m.group(0)
    p,u=item
    if not safe(p):return attr+'='+quote+PREFIX+'unavailable.html'+quote
    dest=destination(p)
    return attr+'='+quote+html.escape(PREFIX+dest+('?' +u.query if u.query and u.query not in {'raw','download'} else '')+('#'+u.fragment if u.fragment else ''),quote=True)+quote
if OUT.exists(): shutil.rmtree(OUT)
for p,body in pages.items():
    body=re.sub(r'(href|src|poster)=([\"\'])(.*?)\2',lambda m:rewrite(m,p),body)
    body=body.replace('http://localhost:8765/',PREFIX).replace('https://bb6.forbiddenweights.com/',PREFIX)
    body=re.sub(r'/home/dennis/[^\s<"\']+', '[local working file]',body)
    body=re.sub(r'(<body\b[^>]*>)',lambda m:m[0]+notice,body,count=1)
    # Source dashboard freshness warnings describe a live rebuild; this is frozen.
    body=body.replace('</head>','<style>.stale{display:none!important}</style></head>')
    dest=OUT/destination(p);dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(body)
for p,data in assets.items():
    if p.endswith('.json'):
        data=re.sub(r'/home/dennis/[^"\s]+', '[local working file]', data.decode()).encode()
    dest=OUT/p;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
(OUT/'index.html').write_text('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=dashboard/index.html"><title>Busy Beaver Challenge dashboard</title></head><body><a href="dashboard/index.html">Open dashboard</a></body></html>')
(OUT/'unavailable.html').write_text('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Snapshot file</title></head><body>'+notice+'<h1>Not included in this public snapshot</h1><p>Internal coordination and local configuration files stay in the working repository.</p></body></html>')
(OUT/'snapshot.json').write_text(json.dumps({'capturedAt':stamp,'pages':len(pages),'assets':len(assets),'omitted':len(omitted)},indent=2)+'\n')
print('Wrote',sum(p.stat().st_size for p in OUT.rglob('*') if p.is_file())//1024//1024,'MiB to',OUT)
