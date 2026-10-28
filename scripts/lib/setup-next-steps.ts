import type { SetupAdminUi } from './setup-config';
import { isPlaceholderGoogleClientEmail } from './setup-google';

export type BeginnerSetupNextStepsInput = {
  googleClientEmail: string | null;
  apiUrl: string | null;
  adminUi: SetupAdminUi;
};

function getUsableGoogleClientEmail(value: string | null) {
  if (!value || isPlaceholderGoogleClientEmail(value)) {
    return null;
  }
  return value;
}

export function formatSheetShareInstruction(googleClientEmail: string | null) {
  const usableEmail = getUsableGoogleClientEmail(googleClientEmail);
  if (usableEmail) {
    return `Share your Google Sheet with ${usableEmail} as Editor before bootstrap or smoke validation.`;
  }

  return 'Add Google service-account credentials, then share your Google Sheet with that service-account email as Editor before bootstrap or smoke validation.';
}

export function formatBeginnerSetupNextSteps(input: BeginnerSetupNextStepsInput) {
  const lines = ['Beginner setup complete.'];
  let stepNumber = 1;
  const usableEmail = getUsableGoogleClientEmail(input.googleClientEmail);

  if (usableEmail) {
    lines.push(`${stepNumber}. Share your Google Sheet with ${usableEmail} as Editor.`);
    stepNumber += 1;
  }

  if (input.apiUrl) {
    lines.push(`${stepNumber}. API URL: ${input.apiUrl}`);
    stepNumber += 1;
  }

  if (input.apiUrl && input.adminUi === 'enabled') {
    lines.push(`${stepNumber}. Admin UI: ${input.apiUrl}/admin/ (sign in with a scoped admin API key).`);
  } else {
    lines.push(`${stepNumber}. Launch the admin UI locally with npm run dev:admin (loopback-only, http://127.0.0.1:4173).`);
  }
  stepNumber += 1;

  lines.push(`${stepNumber}. Run npm run doctor any time you want to re-check this deployment.`);
  return lines;
}
