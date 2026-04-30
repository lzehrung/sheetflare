import { describe, expect, it } from 'vitest';
import { actionsRequireWranglerAuth, parseSetupArgs, resolveSetupActions } from './setup-cli';

describe('parseSetupArgs', () => {
  it('parses combined setup action flags', () => {
    expect(parseSetupArgs(['--config', 'configs/demo/sheetflare.setup.json', '--apply-secrets', '--deploy', '--smoke']))
      .toEqual({
        configPath: 'configs/demo/sheetflare.setup.json',
        writeDefaultConfig: false,
        applySecrets: true,
        deploy: true,
        bootstrap: false,
        smoke: true,
        showSecrets: false
      });
  });

  it('throws on an unknown argument', () => {
    expect(() => parseSetupArgs(['--wat'])).toThrow('Unknown setup argument: --wat');
  });
});

describe('resolveSetupActions', () => {
  it('uses explicit CLI flags when prompt actions are absent', () => {
    const options = parseSetupArgs(['--apply-secrets', '--bootstrap']);

    expect(resolveSetupActions(options, null)).toEqual({
      applySecretsNow: true,
      deployNow: false,
      bootstrapNow: true,
      smokeNow: false
    });
  });

  it('prefers interactive prompt actions when provided', () => {
    const options = parseSetupArgs(['--deploy', '--smoke']);

    expect(resolveSetupActions(options, {
      applySecretsNow: false,
      deployNow: true,
      bootstrapNow: true,
      smokeNow: true
    })).toEqual({
      applySecretsNow: false,
      deployNow: true,
      bootstrapNow: true,
      smokeNow: true
    });
  });
});

describe('actionsRequireWranglerAuth', () => {
  it('requires wrangler auth for deploy or secrets actions only', () => {
    expect(actionsRequireWranglerAuth({
      applySecretsNow: false,
      deployNow: false,
      bootstrapNow: true,
      smokeNow: true
    })).toBe(false);

    expect(actionsRequireWranglerAuth({
      applySecretsNow: true,
      deployNow: false,
      bootstrapNow: false,
      smokeNow: false
    })).toBe(true);
  });
});
