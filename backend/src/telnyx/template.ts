/** A message template with the lead's details filled in. A placeholder with no value is dropped, not sent or read out. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => vars[key] ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]+([,.!?])/g, '$1')
    .trim();
}
