export function isVoiceJoinRequest(text: string): boolean {
  const voiceTarget = /(?:\bvoice\s*(?:chat|channel|call)\b|\bvc\b|음성\s*(?:채널|채팅|방))/iu;
  const joinRequest = /(?:\b(?:come\s+)?join\b|\bcome\s+to\b|\benter\b|들어\s*와|입장|와\s*줘|와\s*줄래)/iu;
  return voiceTarget.test(text) && joinRequest.test(text);
}