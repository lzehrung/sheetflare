import { describe, expect, it } from 'vitest';
import { actionsRequireWranglerAuth, parseSetupArgs, renderSetupHelp, resolveSetupActions } from './setup-cli';

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
      .toEqual({
        configPath: 'configs/demo/sheetflare.setup.json',
        help: false,
        writeDefaultConfig: false,
        applySecrets: true,
        deploy: true,
        bootstrap: false,
        smoke: true,
        verify: true,
        showSecrets: false,
        advanced: false,
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
    expect(help).toContain('npm run setup -- --advanced');
    expect(help).toContain('npm run setup -- --apply-secrets --provision-google');
    expect(help).toContain('npm run setup -- --deploy --bootstrap --smoke --verify');
    expect(help).toContain('npm run doctor');
    expect(help).toContain('--advanced');
    expect(help).toContain('--google-project <id>');
    expect(help).toContain('--google-service-account <name>');
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
