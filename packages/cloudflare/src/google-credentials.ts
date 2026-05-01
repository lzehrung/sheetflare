import { BadRequestError, NotFoundError } from '@sheetflare/contracts';
import type { GoogleServiceAccountConfig } from '@sheetflare/google-sheets';
import type { CloudflareEnv } from './types';

type NamedGoogleCredential = {
  clientEmail: string | undefined;
  privateKey: string | undefined;
};

type GoogleCredentialMap = Record<string, NamedGoogleCredential>;

const defaultGoogleCredentialRef = 'default';

function normalizeGoogleCredential(value: NamedGoogleCredential, ref: string): GoogleServiceAccountConfig {
  const clientEmail = value.clientEmail?.trim() ?? '';
  const privateKey = value.privateKey?.trim() ?? '';

  if (!clientEmail || !privateKey) {
    throw new BadRequestError(`Google credential "${ref}" is incomplete.`, {
      googleCredentialRef: ref
    });
  }

  return {
    clientEmail,
    privateKey
  };
}

function parseGoogleCredentialMap(env: CloudflareEnv): GoogleCredentialMap {
  if (!env.GOOGLE_CREDENTIALS_JSON?.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(env.GOOGLE_CREDENTIALS_JSON);
  } catch (error) {
    throw new BadRequestError('GOOGLE_CREDENTIALS_JSON must be valid JSON.', {
      message: error instanceof Error ? error.message : 'Unknown JSON parse error'
    });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequestError('GOOGLE_CREDENTIALS_JSON must be an object keyed by credential ref.');
  }

  const result: GoogleCredentialMap = {};
  for (const [ref, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestError(`Google credential "${ref}" must be an object with clientEmail and privateKey.`);
    }

    const clientEmail = 'clientEmail' in value && typeof value.clientEmail === 'string'
      ? value.clientEmail
      : null;
    const privateKey = 'privateKey' in value && typeof value.privateKey === 'string'
      ? value.privateKey
      : null;

    if (!clientEmail || !privateKey) {
      throw new BadRequestError(`Google credential "${ref}" must include string clientEmail and privateKey fields.`);
    }

    result[ref] = {
      clientEmail,
      privateKey
    };
  }

  return result;
}

export function resolveGoogleCredential(env: CloudflareEnv, requestedRef: string): GoogleServiceAccountConfig {
  const credentialRef = requestedRef.trim() || defaultGoogleCredentialRef;

  if (credentialRef === defaultGoogleCredentialRef) {
    return normalizeGoogleCredential({
      clientEmail: env.GOOGLE_CLIENT_EMAIL,
      privateKey: env.GOOGLE_PRIVATE_KEY
    }, defaultGoogleCredentialRef);
  }

  const credentials = parseGoogleCredentialMap(env);
  const credential = credentials[credentialRef];
  if (!credential) {
    throw new NotFoundError(`Google credential "${credentialRef}" was not found.`, {
      googleCredentialRef: credentialRef
    });
  }

  return normalizeGoogleCredential(credential, credentialRef);
}

export { defaultGoogleCredentialRef };
