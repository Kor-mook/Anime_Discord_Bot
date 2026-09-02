export function voiceConsentRequiredNotice(websiteUrl: string): string {
  return [
    '🎧 Voice chat is almost ready.',
    'Turn on voice processing on the LoveAI website, then come right back to Discord.',
    `<${websiteUrl}>`
  ].join('\n');
}