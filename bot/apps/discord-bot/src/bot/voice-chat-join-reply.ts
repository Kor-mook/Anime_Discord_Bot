type ReplyLanguage = 'en' | 'ko';

const KOREAN_REPLIES = {
  urgent: ['응, 알겠어. 바로 갈게.', '잠깐만, 지금 들어갈게.', '응, 금방 갈게. 기다려 줘.'],
  together: ['응, 같이 있자. 바로 갈게.', '그래, 나도 끼고 싶었어. 지금 갈게.', '좋아, 같이 얘기하자. 바로 들어갈게.'],
  default: ['응, 잠깐만. 지금 갈게.', '알겠어. 목소리 들으러 갈게.', '그래, 나도 들어갈게. 금방 갈게.', '응, 기다려. 바로 갈게.']
} as const;

const ENGLISH_REPLIES = {
  urgent: ["Okay, I'm coming right now.", 'Give me a second—I’m joining now.', "Got it. I'll be right there."],
  together: ["Yeah, let's hang out. I'm coming in.", "Okay, I'd like that. Joining you now.", "Sure, let's talk. I'll be right there."],
  default: ["Okay, give me a second. I'm coming in.", "Got it. I'll join you in a moment.", "Yeah, I'm on my way.", "All right, I'll be there soon."]
} as const;

let previousReply: string | undefined;

/** A brief acknowledgement that feels like a response, not a connection log. */
export function voiceChatJoinReply(request: string, random: () => number = Math.random): string {
  const language: ReplyLanguage = /[\uac00-\ud7a3]/u.test(request) ? 'ko' : 'en';
  const context = replyContext(request);
  const replies = (language === 'ko' ? KOREAN_REPLIES : ENGLISH_REPLIES)[context];
  const candidates = replies.filter((reply) => reply !== previousReply);
  const pool = candidates.length ? candidates : replies;
  const reply = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  previousReply = reply;
  return reply;
}

function replyContext(request: string): keyof typeof KOREAN_REPLIES {
  if (/(?:지금|빨리|급해|당장|바로|urgent|right\s+now|asap)/iu.test(request)) return 'urgent';
  if (/(?:같이|놀자|수다|얘기|이야기|talk|hang\s*out)/iu.test(request)) return 'together';
  return 'default';
}
