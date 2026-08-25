const KNOWN_GO_FLAGS = new Set(['--force', '--whole-checkout', '--strict']);

export interface ParsedGoArguments {
  force: boolean;
  wholeCheckout: boolean;
  strict: boolean;
  positional: string[];
  unknownFlags: string[];
}

/** Keep the two independent safety waivers independent at the CLI boundary. */
export function parseGoArguments(args: string[]): ParsedGoArguments {
  const flags = new Set(args.filter((arg) => arg.startsWith('--')));

  return {
    force: flags.has('--force'),
    wholeCheckout: flags.has('--whole-checkout'),
    strict: flags.has('--strict'),
    positional: args.filter((arg) => !arg.startsWith('--')),
    unknownFlags: [...flags].filter((flag) => !KNOWN_GO_FLAGS.has(flag)),
  };
}
