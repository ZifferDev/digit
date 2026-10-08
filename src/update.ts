import * as p from '@clack/prompts';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { loadProject, parseManifest } from './config';
import { editManifest } from './manifest-edit';
import { withProjectOperation } from './operations';
import { snapshot, saveProjectFiles } from './project-files';
import { answer } from './prompts';
import { findStableBuild, readLock, resolveLock } from './resolve';
import type { EnvironmentOptions } from './types';

/** Read-only comparison: no operation lock, generated state, or lockfile writes. */
export async function outdatedProject(root: string, options: EnvironmentOptions = {}) {
  const source = await snapshot(join(root, 'digit.toml')),
    originalLock = await snapshot(join(root, 'digit.lock'));
  if (!source) throw new Error(`No digit.toml found at ${root}. Run digit init first.`);
  const before = await readLock(root);
  if (!before)
    throw new Error(
      'No digit.lock found. Run digit update to create the initial lock before checking digit outdated.',
    );
  const project = await loadProject(root, options);
  const after = await resolveLock(project.manifest, before, true);
  const notices: string[] = [];
  for (const [name, service] of Object.entries(project.manifest.services)) {
    const stable = await findStableBuild(
      service,
      before.services[name]?.type === service.type ? before.services[name]?.version : undefined,
    );
    if (stable)
      notices.push(
        `${name}: ${service.type === 'paper' ? 'Paper' : 'Velocity'} ${stable.version} stable build ${stable.build} is available; the experimental channel is still selected.`,
      );
  }
  if (
    (await snapshot(join(root, 'digit.toml')))?.text !== source.text ||
    (await snapshot(join(root, 'digit.lock')))?.text !== originalLock?.text
  )
    throw new Error(
      'Project files changed during the check. Run digit outdated again for a consistent comparison.',
    );
  return { before, after, notices };
}

export interface UpdateOptions extends EnvironmentOptions {
  stable?: boolean;
  keepExperimental?: boolean;
}
export async function updateProject(
  root: string,
  options: UpdateOptions = {},
  dependencies: {
    interactive?: boolean;
    prompts?: typeof p;
    stableBuild?: typeof findStableBuild;
    resolve?: typeof resolveLock;
  } = {},
) {
  if (options.stable && options.keepExperimental)
    throw new Error('Use --stable or --keep-experimental, not both.');
  return withProjectOperation(root, async () => {
    const source = await snapshot(join(root, 'digit.toml')),
      originalLock = await snapshot(join(root, 'digit.lock'));
    if (!source) throw new Error(`No digit.toml found at ${root}. Run digit init first.`);
    const base = parseManifest(parse(source.text)),
      updated = structuredClone(base);
    const project = await loadProject(root, options);
    const before = await readLock(root);
    const prompts = dependencies.prompts ?? p;
    const interactive =
      dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const decisions: string[] = [],
      notices: string[] = [];
    for (const [name, service] of Object.entries(project.manifest.services)) {
      if (
        service.type === 'mariadb' ||
        service.channel !== 'experimental' ||
        options.keepExperimental
      )
        continue;
      const stable = await (dependencies.stableBuild ?? findStableBuild)(
        service,
        before?.services[name]?.type === service.type ? before?.services[name]?.version : undefined,
      );
      if (!stable) continue;
      const label = `${name}: ${service.type === 'paper' ? 'Paper' : 'Velocity'} ${stable.version} stable build ${stable.build}`;
      const adjustments = [
        ...(service.version !== stable.version
          ? [`set version ${service.version} → ${stable.version}`]
          : []),
        ...(service.build !== 'latest'
          ? [`replace pinned build ${service.build} → ${stable.build}`]
          : []),
      ];
      const accepted =
        options.stable ||
        (interactive &&
          answer(
            await prompts.confirm({
              message: `${label} is available. Switch from experimental to stable${adjustments.length ? ` (${adjustments.join('; ')})` : ''}?`,
              initialValue: true,
            }),
          ));
      if (!accepted) {
        notices.push(
          `${label} is available; kept the experimental channel.${interactive ? '' : ' Run digit update interactively or with --stable to switch.'}`,
        );
        continue;
      }
      service.channel = 'stable';
      service.version = stable.version;
      if (service.build !== 'latest') service.build = String(stable.build);
      Object.assign(updated.services[name]!, {
        channel: service.channel,
        version: service.version,
        build: service.build,
      });
      decisions.push(
        `${name}: channel experimental → stable${adjustments.length ? `; ${adjustments.join('; ')}` : ''}`,
      );
    }
    const spin = interactive ? prompts.spinner() : undefined;
    spin?.start('Resolving software and plugin updates…');
    let after;
    try {
      after = await (dependencies.resolve ?? resolveLock)(project.manifest, before, true);
      const nextManifest = editManifest(source.text, base, updated);
      const nextLock = `${JSON.stringify(after, null, 2)}\n`;
      if (nextManifest !== source.text || nextLock !== originalLock?.text)
        await saveProjectFiles(root, source, originalLock, nextManifest, nextLock);
      spin?.stop('Dependency update complete');
    } catch (error) {
      spin?.error('Could not update dependencies');
      throw error;
    }
    return { before, after, decisions, notices };
  });
}
