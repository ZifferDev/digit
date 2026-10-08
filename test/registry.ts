import { mock } from 'bun:test';

export function pluginVersion(
  id: string,
  project: string,
  dependencies: object[] = [],
  overrides = {},
) {
  return {
    id,
    project_id: project,
    version_number: id,
    version_type: 'release',
    date_published: '2026-10-01',
    loaders: ['paper', 'velocity'],
    game_versions: ['1.21.11', '26.2'],
    dependencies,
    files: [
      {
        primary: true,
        filename: `${project}.jar`,
        url: `https://example.com/${project}.jar`,
        hashes: { sha512: 'b'.repeat(128) },
      },
    ],
    ...overrides,
  };
}
export function registry() {
  const projects = new Map([
    ['BackID', { id: 'BackID', slug: 'viabackwards', title: 'ViaBackwards' }],
    ['ViaID', { id: 'ViaID', slug: 'viaversion', title: 'ViaVersion' }],
    ['LuckID', { id: 'LuckID', slug: 'luckperms', title: 'LuckPerms' }],
    ...['A1B2c3d4', '1A2B3c4D', 'a1b2c3d4'].map((id) => [id, { id, slug: id, title: id }] as const),
  ]);
  const versions = new Map<string, ReturnType<typeof pluginVersion>[]>([
    [
      'BackID',
      [pluginVersion('back1', 'BackID', [{ dependency_type: 'required', project_id: 'ViaID' }])],
    ],
    ['ViaID', [pluginVersion('via1', 'ViaID')]],
    ['LuckID', [pluginVersion('luck1', 'LuckID')]],
    ...['A1B2c3d4', '1A2B3c4D', 'a1b2c3d4'].map(
      (id) => [id, [pluginVersion(`v${id}`, id)]] as [string, ReturnType<typeof pluginVersion>[]],
    ),
  ]);
  const calls: string[] = [];
  globalThis.fetch = mock(async (input: unknown) => {
    const url = new URL(String(input));
    calls.push(url.href);
    if (url.host === 'api.modrinth.com') {
      const parts = url.pathname.split('/').map(decodeURIComponent);
      if (parts[2] === 'project') {
        const project =
          projects.get(parts[3]!) ??
          [...projects.values()].find((project) => project.slug === parts[3]);
        if (!project) return new Response('Unknown project', { status: 404 });
        if (!parts[4]) return Response.json(project);
        const choices = versions.get(project.id) ?? [];
        if (!parts[5]) return Response.json(choices);
        const version = choices.find((v) => v.id === parts[5] || v.version_number === parts[5]);
        return version ? Response.json(version) : new Response('Unknown version', { status: 404 });
      }
      if (parts[2] === 'version') {
        const version = [...versions.values()].flat().find((v) => v.id === parts[3]);
        return version ? Response.json(version) : new Response('Unknown version', { status: 404 });
      }
    }
    if (url.host === 'fill.papermc.io') {
      if (url.pathname.endsWith('/versions'))
        return Response.json({
          versions: ['1.21.11', '26.2', '26.3'].map((id) => ({
            version: { id, support: { status: 'SUPPORTED' }, java: { version: { minimum: 21 } } },
            builds: [1],
          })),
        });
      const build = {
        id: 1,
        channel: 'STABLE',
        downloads: {
          'server:default': {
            name: 'server.jar',
            url: 'https://example.com/server.jar',
            checksums: { sha256: 'a'.repeat(64) },
          },
        },
      };
      return Response.json(url.pathname.endsWith('/builds') ? [build] : build);
    }
    if (url.host === 'auth.docker.io') return Response.json({ token: 'fixture' });
    if (url.host === 'registry-1.docker.io')
      return Response.json({
        manifests: ['amd64', 'arm64'].map((architecture) => ({
          platform: { os: 'linux', architecture },
        })),
      });
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
  return { projects, versions, calls };
}
