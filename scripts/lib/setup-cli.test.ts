import { describe, expect, it } from 'vitest';
import { assertRotateKeysApplicable, parseSetupArgs, renderSetupHelp, resolveSetupActions } from './setup-cli';

describe('parseSetupArgs', () => {
  it('parses combined setup action flags', () => {
    expect(parseSetupArgs([
      '--config',
      'configs/demo/sheetflare.setup.json',
      '--apply-secrets',
      '--deploy',
      '--smoke',
      '--verify',
      '--provision-google',
      '--google-project',
      'sheetflare-prod',
      '--google-service-account',
      'sheetflare-prod'
    ]))
      .toMatchObject({
        configPath: 'configs/demo/sheetflare.setup.json',
        help: false,
        writeDefaultConfig: false,
        applySecrets: true,
        deploy: true,
        bootstrap: false,
        smoke: true,
        verify: true,
        rotateKeys: false,
        advanced: false,
        debug: false,
        provisionGoogle: true,
        googleProjectId: 'sheetflare-prod',
        googleServiceAccountName: 'sheetflare-prod'
      });
  });

  it('parses advanced setup mode', () => {
    expect(parseSetupArgs(['--advanced'])).toMatchObject({
      advanced: true
    });
  });

  it('parses debug setup output mode', () => {
    expect(parseSetupArgs(['--debug'])).toMatchObject({
      debug: true
    });
  });

  it('parses key rotation', () => {
    expect(parseSetupArgs(['--bootstrap', '--rotate-keys'])).toMatchObject({
      bootstrap: true,
      rotateKeys: true
    });
    expect(parseSetupArgs(['--bootstrap']).rotateKeys).toBe(false);
  });

  it('no longer accepts --show-secrets because minted credentials are always handed over once', () => {
    expect(() => parseSetupArgs(['--show-secrets'])).toThrow('Unknown setup argument: --show-secrets');
  });

  it('parses an explicit setup profile', () => {
    expect(parseSetupArgs(['--profile', 'staging'])).toMatchObject({
      profile: 'staging'
    });
  });

  it('rejects a profile flag without a value', () => {
    expect(() => parseSetupArgs(['--profile'])).toThrow('Missing value for --profile.');
  });

  it('parses help flags without treating them as unknown arguments', () => {
    expect(parseSetupArgs(['--help']).help).toBe(true);
    expect(parseSetupArgs(['-h']).help).toBe(true);
  });

  it('lets help win before validating later arguments', () => {
    expect(parseSetupArgs(['--help', '--wat'])).toMatchObject({
      help: true
    });
  });

  it('throws on an unknown argument', () => {
    expect(() => parseSetupArgs(['--wat'])).toThrow('Unknown setup argument: --wat');
  });

  it('throws clearly when a Google provisioning flag is missing its value', () => {
    expect(() => parseSetupArgs(['--google-project'])).toThrow('Missing value for --google-project.');
    expect(() => parseSetupArgs(['--google-service-account'])).toThrow('Missing value for --google-service-account.');
  });
});

describe('renderSetupHelp', () => {
  it('documents common operator setup flows and flags', () => {
    const help = renderSetupHelp();

    expect(help).toContain('Usage: npm run setup -- [options]');
    expect(help).toContain('beginner questions');
    expect(help).toContain('npm run setup -- --advanced');
    expect(help).toContain('npm run setup -- --apply-secrets --provision-google');
    expect(help).toContain('npm run setup -- --deploy --bootstrap --smoke --verify');
    expect(help).toContain('npm run doctor');
    expect(help).toContain('--advanced');
    expect(help).toContain('--rotate-keys');
    expect(help).toContain('--google-project <id>');
    expect(help).toContain('--google-service-account <name>');
    expect(help).toContain('shown once');
    expect(help).not.toContain('--show-secrets');
  });
});

describe('resolveSetupActions', () => {
  it('uses explicit CLI flags when prompt actions are absent', () => {
    const options = parseSetupArgs(['--apply-secrets', '--bootstrap']);

    expect(resolveSetupActions(options, null)).toEqual({
      applySecretsNow: true,
      deployNow: false,
      bootstrapNow: true,
      smokeNow: false,
      verifyNow: false
    });
  });

  it('prefers interactive prompt actions when provided', () => {
    const options = parseSetupArgs(['--deploy', '--smoke']);

    expect(resolveSetupActions(options, {
      applySecretsNow: false,
      deployNow: true,
      bootstrapNow: true,
      smokeNow: true,
      verifyNow: true
    })).toEqual({
      applySecretsNow: false,
      deployNow: true,
      bootstrapNow: true,
      smokeNow: true,
      verifyNow: true
    });
  });

  it('preserves explicit CLI action flags when prompt actions are provided', () => {
    const options = parseSetupArgs(['--verify', '--smoke']);

    expect(resolveSetupActions(options, {
      applySecretsNow: false,
      deployNow: false,
      bootstrapNow: false,
      smokeNow: false,
      verifyNow: false
    })).toEqual({
      applySecretsNow: false,
      deployNow: false,
      bootstrapNow: false,
      smokeNow: true,
      verifyNow: true
    });
  });

  it('maps explicit verify flags into setup actions', () => {
    const options = parseSetupArgs(['--verify']);

    expect(resolveSetupActions(options, null)).toMatchObject({
      verifyNow: true
    });
  });
});

describe('assertRotateKeysApplicable', () => {
  it('accepts --rotate-keys when bootstrap will run', () => {
    const options = parseSetupArgs(['--bootstrap', '--rotate-keys']);

    expect(() => assertRotateKeysApplicable(options, resolveSetupActions(options, null))).not.toThrow();
  });

  it('rejects --rotate-keys when bootstrap will not run, instead of silently doing nothing', () => {
    const options = parseSetupArgs(['--smoke', '--rotate-keys']);

    expect(() => assertRotateKeysApplicable(options, resolveSetupActions(options, null))).toThrow(
      '--rotate-keys only applies when setup bootstraps keys. Add --bootstrap.'
    );
  });

  it('ignores runs that did not ask for rotation', () => {
    const options = parseSetupArgs(['--smoke']);

    expect(() => assertRotateKeysApplicable(options, resolveSetupActions(options, null))).not.toThrow();
  });
});
