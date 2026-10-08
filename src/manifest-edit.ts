import { parseTOML, type AST } from 'toml-eslint-parser';
import { parse } from 'smol-toml';
import { hash, parseManifest } from './config';
import type { Manifest } from './types';

const key = (parts: string[]) =>
  parts.map((part) => (/^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part))).join('.');
function value(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(value).join(', ')}]`;
  if (input && typeof input === 'object')
    return `{ ${Object.entries(input)
      .map(([k, v]) => `${key([k])} = ${value(v)}`)
      .join(', ')} }`;
  return JSON.stringify(input);
}
const prefix = (a: string[], b: string[]) =>
  a.length <= b.length && a.every((part, i) => b[i] === part);
const equal = (a: string[], b: string[]) => a.length === b.length && prefix(a, b);

/** Change only the requested TOML values, retaining unrelated formatting and comments. */
function set(text: string, path: string[], input: unknown): string {
  const ast = parseTOML(text);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const entries: { path: string[]; node: AST.TOMLKeyValue }[] = [];
  const tables: { path: string[]; node: AST.TOMLTable | AST.TOMLInlineTable }[] = [];
  function visit(body: (AST.TOMLKeyValue | AST.TOMLTable)[], base: string[]) {
    for (const node of body) {
      if (node.type === 'TOMLTable') {
        const path = node.resolvedKey.map(String);
        tables.push({ path, node });
        visit(node.body, path);
      } else {
        const path = [
          ...base,
          ...node.key.keys.map((part) => (part.type === 'TOMLBare' ? part.name : part.value)),
        ];
        entries.push({ path, node });
        if (node.value.type === 'TOMLInlineTable') {
          tables.push({ path, node: node.value });
          visit(node.value.body, path);
        }
      }
    }
  }
  visit(ast.body[0].body, []);
  const entry = entries.find((entry) => equal(entry.path, path));
  const replace = (start: number, end: number, content: string) =>
    text.slice(0, start) + content + text.slice(end);
  if (input !== undefined && entry) return replace(...entry.node.value.range, value(input));
  if (input === undefined) {
    if (entry?.node.parent.type === 'TOMLInlineTable') {
      const siblings = entry.node.parent.body;
      const index = siblings.indexOf(entry.node);
      const next = siblings[index + 1],
        previous = siblings[index - 1];
      return replace(
        previous ? previous.range[1] : entry.node.range[0],
        next && !previous ? next.range[0] : entry.node.range[1],
        '',
      );
    }
    if (entry) return replace(...entry.node.range, '');
    const table = tables.find(
      (table) => equal(table.path, path) && table.node.type === 'TOMLTable',
    );
    const ranges = table
      ? [table.node.range]
      : entries.filter((entry) => prefix(path, entry.path)).map((entry) => entry.node.range);
    for (const [start, end] of ranges.sort((a, b) => b[0] - a[0]))
      text = text.slice(0, start) + text.slice(end);
    return text;
  }
  const parent = tables
    .filter((table) => prefix(table.path, path) && table.path.length < path.length)
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (parent?.node.type === 'TOMLInlineTable') {
    const index = parent.node.range[1] - 1;
    return replace(
      index,
      index,
      `${parent.node.body.length ? ', ' : ''}${key(path.slice(parent.path.length))} = ${value(input)} `,
    );
  }
  // Give each new plugin a readable declaration, unless its parent is inline above.
  if (path[0] === 'plugins' && path.length === 2) {
    return `${text}${text.endsWith('\n') ? '' : newline}${newline}[${key(path)}]${newline}${Object.entries(
      input as object,
    )
      .map(([k, v]) => `${key([k])} = ${value(v)}`)
      .join(newline)}${newline}`;
  }
  let position: number;
  if (parent) {
    const lineEnd = text.indexOf('\n', parent.node.range[1]);
    position = lineEnd < 0 ? text.length : lineEnd + 1;
  } else
    position = ast.body[0].body.find((node) => node.type === 'TOMLTable')?.range[0] ?? text.length;
  const leading = position > 0 && text[position - 1] !== '\n' ? newline : '';
  return replace(
    position,
    position,
    `${leading}${key(path.slice(parent?.path.length ?? 0))} = ${value(input)}${newline}`,
  );
}

export function editManifest(text: string, before: Manifest, after: Manifest): string {
  let output = text;
  for (const alias of new Set([...Object.keys(before.plugins), ...Object.keys(after.plugins)]))
    if (hash(before.plugins[alias] ?? null) !== hash(after.plugins[alias] ?? null))
      output = set(output, ['plugins', alias], after.plugins[alias]);
  for (const [name, service] of Object.entries(after.services)) {
    if (hash(before.services[name]!.plugins) !== hash(service.plugins))
      output = set(output, ['services', name, 'plugins'], service.plugins);
    for (const field of ['channel', 'version', 'build'] as const)
      if (before.services[name]![field] !== service[field])
        output = set(output, ['services', name, field], service[field]);
  }
  // Never write a partial/ambiguous edit of an unusual but valid TOML representation.
  if (hash(parseManifest(parse(output))) !== hash(after))
    throw new Error('Could not safely edit this manifest. No files were changed.');
  return output;
}
