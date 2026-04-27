import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function resolveReportPaths(reportPath: string) {
  const normalized = reportPath.trim();
  const markdownPath = normalized.toLowerCase().endsWith('.md')
    ? normalized
    : `${normalized}.md`;
  const jsonPath = markdownPath.slice(0, -3) + '.json';

  return {
    markdownPath,
    jsonPath
  };
}

export async function writeReportArtifacts(
  reportPath: string,
  markdown: string,
  data: unknown
) {
  const { markdownPath, jsonPath } = resolveReportPaths(reportPath);
  await mkdir(path.dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, markdown, 'utf8');
  await writeFile(jsonPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return {
    markdownPath,
    jsonPath
  };
}

export function summarizeJson(value: unknown, maxLength = 600) {
  const formatted = JSON.stringify(value, null, 2);
  if (formatted.length <= maxLength) {
    return formatted;
  }

  return `${formatted.slice(0, maxLength - 3)}...`;
}
