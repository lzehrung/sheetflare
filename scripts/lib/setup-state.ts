import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ScriptError } from './runtime';

export type SetupLocalState = {
  googleClientEmail?: string;
  apiUrl?: string;
  adminUrl?: string;
  adminBearerToken?: string;
  adminUiUsername?: string;
  adminUiPassword?: string;
  adminApiKey?: string;
  privateReadKey?: string;
  mutationKey?: string;
};

type SetupLocalStateInputValue = SetupLocalState[keyof SetupLocalState] | null | undefined;
const allowedSetupLocalStateKeys = new Set<keyof SetupLocalState>([
  'googleClientEmail',
  'apiUrl',
  'adminUrl',
  'adminBearerToken',
  'adminUiUsername',
  'adminUiPassword',
  'adminApiKey',
  'privateReadKey',
  'mutationKey'
]);

function isMissingFileError(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function getSetupLocalStatePath(configPath: string) {
  return join(dirname(resolve(configPath)), '.sheetflare.setup.local.json');
}

export async function readSetupLocalState(configPath: string) {
  const path = getSetupLocalStatePath(configPath);
  try {
    const text = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ScriptError(`Setup local state ${path} must contain a JSON object.`);
    }

    const state = createSetupLocalStateFromUnknown(parsed, path);
    return state;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    if (error instanceof ScriptError) {
      throw error;
    }
    throw new ScriptError(`Setup local state ${path} must contain valid JSON.`);
  }
}

export function createSetupLocalStateFromUnknown(input: unknown, path = 'setup local state'): SetupLocalState {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ScriptError(`${path} must contain a JSON object.`);
  }

  const state: SetupLocalState = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (!allowedSetupLocalStateKeys.has(rawKey as keyof SetupLocalState)) {
      throw new ScriptError(`${path} contains unknown key ${rawKey}.`);
    }
    if (typeof rawValue !== 'string') {
      throw new ScriptError(`${path}.${rawKey} must be a string.`);
    }
    if (rawValue.trim().length === 0) {
      throw new ScriptError(`${path}.${rawKey} must not be blank.`);
    }
    state[rawKey as keyof SetupLocalState] = rawValue;
  }

  return state;
}

export async function writeSetupLocalState(configPath: string, state: SetupLocalState) {
  const path = getSetupLocalStatePath(configPath);
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return path;
}

export function createSetupLocalState(entries: Partial<Record<keyof SetupLocalState, SetupLocalStateInputValue>>) {
  const state: SetupLocalState = {};
  for (const [key, value] of Object.entries(entries) as Array<[keyof SetupLocalState, SetupLocalStateInputValue]>) {
    if (typeof value === 'string' && value.trim().length > 0) {
      state[key] = value;
    }
  }
  return state;
}

function redactValue(value: string | undefined) {
  if (!value) {
    return null;
  }
  if (value.length <= 8) {
    return `${value.slice(0, 2)}***`;
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function redactSetupLocalState(state: SetupLocalState) {
  return {
    googleClientEmail: state.googleClientEmail ?? null,
    apiUrl: state.apiUrl ?? null,
    adminUrl: state.adminUrl ?? null,
    adminBearerToken: redactValue(state.adminBearerToken),
    adminUiUsername: state.adminUiUsername ?? null,
    adminUiPassword: redactValue(state.adminUiPassword),
    adminApiKey: redactValue(state.adminApiKey),
    privateReadKey: redactValue(state.privateReadKey),
    mutationKey: redactValue(state.mutationKey)
  };
}
