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
});

describe('formatBeginnerSetupNextSteps', () => {
  it('prints share, URL, and verification guidance without secret values', () => {
    expect(formatBeginnerSetupNextSteps({
      googleClientEmail: 'service-account@example.com',
      apiUrl: 'https://sheetflare-api.example.workers.dev',
      adminUrl: 'https://sheetflare-admin.pages.dev'
    })).toEqual([
      'Beginner setup next steps:',
      '1. Share your Google Sheet with service-account@example.com as Editor before bootstrap or smoke validation.',
      '2. API URL: https://sheetflare-api.example.workers.dev',
      '3. Admin URL: https://sheetflare-admin.pages.dev',
      '4. Run npm run doctor any time you want to re-check this deployment.'
    ]);
  });

  it('omits unavailable deployment URLs and keeps the doctor step numbered correctly', () => {
    expect(formatBeginnerSetupNextSteps({
      googleClientEmail: 'service-account@example.com',
      apiUrl: null,
      adminUrl: null
    })).toEqual([
      'Beginner setup next steps:',
      '1. Share your Google Sheet with service-account@example.com as Editor before bootstrap or smoke validation.',
      '2. Run npm run doctor any time you want to re-check this deployment.'
    ]);
  });

  it('uses a credential remediation when the service-account email is not known yet', () => {
    expect(formatBeginnerSetupNextSteps({
      googleClientEmail: null,
      apiUrl: null,
      adminUrl: null
    })).toEqual([
      'Beginner setup next steps:',
      '1. Add Google service-account credentials, then share your Google Sheet with that service-account email as Editor before bootstrap or smoke validation.',
      '2. Run npm run doctor any time you want to re-check this deployment.'
    ]);
  });
});
