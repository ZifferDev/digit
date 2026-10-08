import * as p from '@clack/prompts';

export class Cancelled extends Error {
  constructor(message = 'Cancelled. No project files were changed.') {
    super(message);
    this.name = 'Cancelled';
  }
}
export function answer<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) throw new Cancelled();
  return value as Exclude<T, symbol>;
}
