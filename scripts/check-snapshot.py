"""Verify the static clone's local navigation, assets and module imports."""
import pathlib, re, urllib.parse
from html.parser import HTMLParser
root=pathlib.Path('public'); errors=[]; count=0
class Parser(HTMLParser):
 def handle_starttag(self,tag,attrs):
  global count
  for k,v in attrs:
   if k not in {'href','src','poster'} or not v or not v.startswith('/busy-beaver/'):continue
   count+=1
   p=root/urllib.parse.unquote(urllib.parse.urlsplit(v).path.lstrip('/'))
   if p.is_dir():p=p/'index.html'
   if not p.is_file():errors.append((str(file),v))
for file in (root/'busy-beaver').rglob('*.html'):
 text=file.read_text();Parser().feed(text)
 if re.search(r'(?:ghp_[A-Za-z0-9]{20}|sk-proj-[A-Za-z0-9]{20}|/home/dennis|/mnt/c/)',text):errors.append((str(file),'private path or credential pattern'))
for file in (root/'busy-beaver/tools').rglob('*.mjs'):
 for ref in re.findall(r'(?:from\s+|import\s*\(|new URL\s*\()\s*[\'\"](\.[^\'\"]+)',file.read_text()):
  if not (file.parent/ref).is_file():errors.append((str(file),ref))
if errors:
 print('\n'.join(map(str,errors[:30])));raise SystemExit(f'{len(errors)} failures')
print(f'Snapshot: {count} local references and JavaScript imports checked.')
