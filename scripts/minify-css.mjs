// Collapse comments and whitespace without changing quoted CSS values.
export function minifyCSS(source) {
  let output = '', quote = '', space = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      output += char;
      if (char === '\\') output += source[++i] ?? '';
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unclosed CSS comment');
      i = end + 1;
      continue;
    }
    if (/\s/.test(char)) { space = true; continue; }
    if (space && output && !/[{};]/.test(char) && !/[{};]$/.test(output)) output += ' ';
    space = false;
    output += char;
    if (char === '"' || char === "'") quote = char;
  }
  if (quote) throw new Error('Unclosed CSS string');
  return output;
}
