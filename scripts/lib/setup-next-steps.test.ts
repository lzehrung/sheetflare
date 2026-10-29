import { describe, expect, it } from 'vitest';
import { formatBeginnerSetupNextSteps, formatSheetShareInstruction } from './setup-next-steps';

describe('formatSheetShareInstruction', () => {
  it('prints the exact service-account sharing instruction when known', () => {
    expect(formatSheetShareInstruction('service-account@example.com'))
      .toBe('Share your Google Sheet with service-account@example.com as Editor before bootstrap or smoke validation.');
  });

  it('prints a credential-first instruction when the email is unknown', () => {
    expect(formatSheetShareInstruction(null))
      .toBe('Add Google service-account credentials, then share your Google Sheet with that service-account email as Editor before bootstrap or smoke validation.');
  });

  it('prints a credential-first instruction for the checked-in placeholder email', () => {
    expect(formatSheetShareInstruction('service-account@your-gcp-project.iam.gserviceaccount.com'))
      .toBe('Add Google service-account credentials, then share your Google Sheet with that service-account email as Editor before bootstrap or smoke validation.');
  });
});

describe('formatBeginnerSetupNextSteps', () => {
  it('directs a completed setup to the hosted admin UI', () => {
    expect(formatBeginnerSetupNextSteps({
      googleClientEmail: 'service-account@example.com',
      apiUrl: 'https://sheetflare-api.example.workers.dev',
      adminUi: 'enabled'
    })).toEqual([
      'Beginner setup complete.',
      '1. Share your Google Sheet with service-account@example.com as Editor.',
      '2. API URL: https://sheetflare-api.example.workers.dev',
      '3. Admin UI: https://sheetflare-api.example.workers.dev/admin/ (sign in with a scoped admin API key).',
      '4. Run npm run doctor any time you want to re-check this deployment.'
    ]);
  });

  it('points to the local admin UI when the hosted admin is disabled', () => {
    expect(formatBeginnerSetupNextSteps({
      googleClientEmail: null,
      apiUrl: 'https://sheetflare-api.example.workers.dev',
      adminUi: 'disabled'
    })).toEqual([
      'Beginner setup complete.',
      '1. API URL: https://sheetflare-api.example.workers.dev',
      '2. Launch the admin UI locally with npm run dev:admin (loopback-only, http://127.0.0.1:4173).',
      '3. Run npm run doctor any time you want to re-check this deployment.'
    ]);
  });

  it('keeps local admin and doctor guidance when deployment details are unavailable', () => {
    expect(formatBeginnerSetupNextSteps({
      googleClientEmail: null,
      apiUrl: null,
      adminUi: 'enabled'
    })).toEqual([
      'Beginner setup complete.',
      '1. Launch the admin UI locally with npm run dev:admin (loopback-only, http://127.0.0.1:4173).',
      '2. Run npm run doctor any time you want to re-check this deployment.'
    ]);
  });
});
