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
  it('directs a completed setup to the loopback-only local admin UI', () => {
    expect(formatBeginnerSetupNextSteps({
      googleClientEmail: 'service-account@example.com',
      apiUrl: 'https://sheetflare-api.example.workers.dev'
    })).toEqual([
      'Beginner setup complete.',
      '1. Share your Google Sheet with service-account@example.com as Editor.',
      '2. API URL: https://sheetflare-api.example.workers.dev',
      '3. Launch the admin UI any time with npm run dev:admin (loopback-only, http://127.0.0.1:4173; it targets your deployed API automatically).',
      '4. Run npm run doctor any time you want to re-check this deployment.'
    ]);
  });

  it('keeps local admin and doctor guidance when deployment details are unavailable', () => {
    expect(formatBeginnerSetupNextSteps({
      googleClientEmail: null,
      apiUrl: null
    })).toEqual([
      'Beginner setup complete.',
      '1. Launch the admin UI any time with npm run dev:admin (loopback-only, http://127.0.0.1:4173; it targets your deployed API automatically).',
      '2. Run npm run doctor any time you want to re-check this deployment.'
    ]);
  });
});
