import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const files = [
  'README.md',
  ...Array.from(new Bun.Glob('docs/**/*.md').scanSync({ cwd: root })),
  ...Array.from(new Bun.Glob('examples/**/*.md').scanSync({ cwd: root })),
];
const errors: string[] = [];
for (const file of files) {
  const content = (await Bun.file(resolve(root, file)).text()).replace(/```[\s\S]*?```/g, '');
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const link = match[1]!.replace(/^<|>$/g, '');
    if (/^(?:[a-z]+:|#|\/\/)/i.test(link)) continue;
    const path = decodeURIComponent(link.split('#')[0]!.split('?')[0]!);
    if (!path) continue;
    try {
      await stat(resolve(root, dirname(file), path));
    } catch {
      errors.push(`${file}: missing link target ${link}`);
    }
  }
}
if (errors.length) throw new Error(errors.join('\n'));
console.log(`Checked local links in ${files.length} Markdown documents.`);
