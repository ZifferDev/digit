import { expect, test } from 'bun:test';
import { parse } from 'smol-toml';
import { parseManifest } from '../src/config';
import { editManifest } from '../src/manifest-edit';

const fixtures = [
  'name="friends"\n# world\n[services.survival] # header\ntype="paper"\nversion="1.21.11" # keep\n',
  'name="friends"\n[services."survival"]\ntype="paper"\nplugins = [\n  # existing list\n]\n[services.survival.properties]\ndifficulty="hard"\n',
  'name="friends"\nservices.survival.type="paper"\nservices.survival.version="1.21.11"\n',
  'name="friends"\n[services]\nsurvival = { type = "paper", version="1.21.11" }\nplugins_dummy_should_not_exist="bad"\n'.replace(
    'plugins_dummy_should_not_exist="bad"\n',
    '',
  ),
  'name="friends"\nservices = { survival = { type = "paper" } }\nplugins={}\n',
  'name="friends"\r\n[services.survival]\r\ntype="paper" # keep CRLF\r\n',
  'name="friends"\n[services.survival]\ntype="paper"',
];
test.each(fixtures)('edits normal, dotted, quoted and inline service tables: %s', (source) => {
  const before = parseManifest(parse(source));
  const after = structuredClone(before);
  after.plugins.viabackwards = { source: 'modrinth', project: 'BackID', version: 'latest' };
  after.services.survival!.plugins.push('viabackwards');
  const edited = editManifest(source, before, after);
  expect(parseManifest(parse(edited))).toEqual(after);
  expect(edited).toContain('name="friends"');
  if (source.includes('# keep'))
    expect(edited).toContain(source.includes('CRLF') ? '# keep CRLF' : '# keep');
  const removed = editManifest(edited, after, before);
  expect(parseManifest(parse(removed))).toEqual(before);
});
test.each([
  '[plugins.one]\nsource="modrinth"\nproject="one"\n[plugins.two]\nsource="modrinth"\nproject="two"\n',
  '[plugins]\none={source="modrinth",project="one"}\ntwo={source="modrinth",project="two"}\n',
  '[plugins]\none.source="modrinth"\none.project="one"\ntwo.source="modrinth"\ntwo.project="two"\n',
])('removes only one declaration from varied plugin table forms: %s', (plugins) => {
  const source =
    'name="friends"\n[services.survival]\ntype="paper"\nplugins=["one","two"] # keep list note\n' +
    plugins;
  const before = parseManifest(parse(source));
  const after = structuredClone(before);
  delete after.plugins.one;
  after.services.survival!.plugins = ['two'];
  const edited = editManifest(source, before, after);
  expect(parseManifest(parse(edited))).toEqual(after);
  expect(edited).toContain('# keep list note');
});
test.each(['one', 'two', 'three'])(
  'removes %s from an inline plugin table without damaging commas',
  (alias) => {
    const source =
      'name="friends"\nplugins={ one={source="modrinth",project="one"}, two={source="modrinth",project="two"}, three={source="modrinth",project="three"} }\n[services.survival]\ntype="paper"\n';
    const before = parseManifest(parse(source));
    const after = structuredClone(before);
    delete after.plugins[alias];
    expect(parseManifest(parse(editManifest(source, before, after)))).toEqual(after);
  },
);
test('inserting before a nested table preserves a trailing service comment and its scope', () => {
  const source =
    'name="friends"\n[services.survival]\ntype="paper" # server type\n[services.survival.env]\nOPS="m07z"\n';
  const before = parseManifest(parse(source));
  const after = structuredClone(before);
  after.plugins.example = { source: 'modrinth', project: 'example', version: 'latest' };
  after.services.survival!.plugins = ['example'];
  const edited = editManifest(source, before, after);
  expect(parseManifest(parse(edited))).toEqual(after);
  expect(edited).toContain('type="paper" # server type');
});
