export type BeginnerSetupNextStepsInput = {
  googleClientEmail: string | null;
  apiUrl: string | null;
  adminUrl: string | null;
};

export function formatSheetShareInstruction(googleClientEmail: string | null) {
  if (googleClientEmail) {
    return `Share your Google Sheet with ${googleClientEmail} as Editor before bootstrap or smoke validation.`;
  }

  return 'Add Google service-account credentials, then share your Google Sheet with that service-account email as Editor before bootstrap or smoke validation.';
}

export function formatBeginnerSetupNextSteps(input: BeginnerSetupNextStepsInput) {
  const lines = ['Beginner setup next steps:'];
  let stepNumber = 1;

  lines.push(`${stepNumber}. ${formatSheetShareInstruction(input.googleClientEmail)}`);
  stepNumber += 1;

  if (input.apiUrl) {
    lines.push(`${stepNumber}. API URL: ${input.apiUrl}`);
    stepNumber += 1;
  }

  if (input.adminUrl) {
    lines.push(`${stepNumber}. Admin URL: ${input.adminUrl}`);
    stepNumber += 1;
  }

  lines.push(`${stepNumber}. Run npm run doctor any time you want to re-check this deployment.`);
  return lines;
}
