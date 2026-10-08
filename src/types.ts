export interface Service {
  type: 'paper' | 'velocity' | 'mariadb';
  version: string;
  build: string;
  channel: 'stable' | 'experimental';
  memory: string;
  plugins: string[];
  fallback?: string[];
  properties: Record<string, string | number | boolean>;
  env: Record<string, string | number | boolean>;
}
export interface Plugin {
  source: 'modrinth';
  project: string;
  version: string;
}
export interface Manifest {
  schema: 1;
  name: string;
  services: Record<string, Service>;
  plugins: Record<string, Plugin>;
  network: { bind: string; port: number; motd: string };
}
export interface Artifact {
  url: string;
  sha256?: string;
  sha512?: string;
  filename: string;
}
export interface LockedPlugin extends Artifact {
  /** Filename label: first sorted manifest alias, or the dependency project ID. */
  name?: string;
  aliases?: string[];
  project: string;
  version: string;
}
export interface LockedService {
  inputHash?: string;
  softwareInputHash?: string;
  type: Service['type'];
  version: string;
  build?: number;
  java?: number;
  channel?: string;
  image: string;
  artifact?: Artifact;
  plugins: LockedPlugin[];
}
export interface Lockfile {
  schema: 1;
  inputHash: string;
  services: Record<string, LockedService>;
}
export interface Project {
  root: string;
  manifest: Manifest;
}
export interface EnvironmentOptions {
  env?: string;
  profile?: string;
}
export interface Deployment {
  directory: string;
  composeFile: string;
  projectName: string;
  environment: string;
  manifest: Manifest;
  lock: Lockfile;
  fingerprint: string;
  entrypoint: string;
}
export interface PaperVersion {
  id: string;
  supported: boolean;
  experimental: boolean;
  java: number;
}
