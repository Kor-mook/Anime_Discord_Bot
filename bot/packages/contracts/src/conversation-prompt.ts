import type { TurnEnvelope, TurnInputSource } from './index.js';

export type ConversationMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type ConversationPromptContext = {
  /** Trusted runtime instructions derived from validated settings. */
  instructions?: string;
  /** Properly role-separated recent turns, oldest first. */
  recentMessages?: ConversationMessage[];
  /** Trusted timestamp of the most recent completed exchange in this conversation. */
  lastInteractionAt?: string;
};

export type ConversationStyleState = {
  language: 'ko' | 'en' | 'ja';
  speechLevel?: 'polite' | 'casual';
  interactionType: 'greeting' | 'casual_chat' | 'question' | 'emotional_support' | 'playful' | 'technical' | 'request';
  userEnergy: 'low' | 'normal' | 'high';
  desiredLength: 'very_short' | 'short' | 'normal';
  relationshipTone: 'new' | 'friend' | 'flirting' | 'romantic';
  usesShortMessages: boolean;
  usesLaughter: boolean;
  usesEmoji: boolean;
  usesSlang: boolean;
};

export type ConversationMove =
  | 'direct_answer'
  | 'specific_reaction'
  | 'gentle_curiosity'
  | 'reciprocal_share'
  | 'open_thread_callback'
  | 'shared_delight'
  | 'emotional_attunement'
  | 'empathic_curiosity'
  | 'practical_care'
  | 'playful_nudge'
  | 'quiet_presence'
  | 'topic_offer';

export type ConversationSituationState = {
  topic: 'greeting' | 'positive_update' | 'daily_update' | 'answering_seline' | 'about_seline' | 'emotional' | 'playful' | 'task' | 'general';
  emotionalSignal: 'positive' | 'low' | 'upset' | 'anxious' | 'playful' | 'neutral';
  openness: 'guarded' | 'brief' | 'normal' | 'engaged';
  memoryOpportunity: 'none' | 'preference' | 'routine' | 'person' | 'emotion_pattern' | 'plan' | 'value';
  questionStreak: number;
  underexploredPersonalThread: boolean;
  recentMoves: ConversationMove[];
  selectedMove: ConversationMove;
};

export type ConversationPrompt = {
  messages: ConversationMessage[];
  source: TurnInputSource;
  style: ConversationStyleState;
  situation: ConversationSituationState;
  speechLevel?: 'polite' | 'casual';
  recentAssistantOpenings: string[];
};

export type NaturalnessIssue =
  | 'reasoning_leak'
  | 'assistant_cliche'
  | 'repeated_opening'
  | 'mixed_speech_level'
  | 'forced_questions'
  | 'interview_rhythm'
  | 'voice_unfriendly_format'
  | 'voice_too_long'
  | 'presumed_shared_context'
  | 'detached_greeting';

const NATURAL_CONVERSATION_INSTRUCTION = [
  'Continue the conversation like a real person, not a customer-service assistant.',
  'React to the specific meaning or feeling of the latest message, then say the useful thing directly.',
  'Use ordinary contemporary wording and concrete context-specific phrasing.',
  'Make casual conversation mutual: sometimes notice, sometimes ask, sometimes share a small thought or preference, sometimes simply stay with the moment.',
  'Treat curiosity as a natural expression of care, never as information harvesting. Follow one thread at a time and back off immediately when the user is guarded.',
  'Do not infer a user\'s mood, desire for space, or willingness to talk from a short reply alone. A brief acknowledgement is usually best unless the user clearly states a boundary or feeling.',
  'Treat facts in the latest message as newly learned unless recent conversation or supplied memory explicitly establishes shared knowledge. React with discovery, not fake confirmation; do not lead with phrases equivalent to "I knew it", "of course", "indeed", or "ah, it really is ..." when Seline was just told.',
  'Do not summarize the user\'s message back to them, explain obvious context, narrate your own behavior, or force a question into every reply.',
  'Avoid polished assistant clichés, stock empathy, repeated openings, and repeated sentence shapes.',
  'A plain short reply is better than performing the character in every turn.'
].join(' ');

export function conversationSource(input: Pick<TurnEnvelope, 'modality' | 'source'>): TurnInputSource {
  return input.source ?? (input.modality === 'voice' ? 'voice_transcript' : 'discord_text');
}

export function buildConversationPrompt(input: TurnEnvelope, options: {
  systemInstruction?: string;
  context?: string | ConversationPromptContext;
}): ConversationPrompt {
  const source = conversationSource(input);
  const context = normalizeContext(options.context);
  const recentMessages = boundedRecentMessages(context.recentMessages ?? [], source === 'discord_text' ? 12 : 8);
  const style = conversationStyle(input, recentMessages, source);
  const situation = conversationSituation(input, recentMessages, style);
  const speechLevel = style.speechLevel;
  const recentAssistantOpenings = recentMessages
    .filter((message) => message.role === 'assistant')
    .map((message) => openingOf(message.content))
    .filter(Boolean)
    .slice(-5);
  const system = [
    options.systemInstruction,
    options.systemInstruction ? NATURAL_CONVERSATION_INSTRUCTION : undefined,
    modalityInstruction(source),
    styleInstruction(style, recentAssistantOpenings),
    situationInstruction(situation, style),
    reconnectionInstruction(input.occurredAt, context.lastInteractionAt, situation.topic, style.relationshipTone),
    context.instructions
  ].filter((value): value is string => Boolean(value?.trim())).join('\n\n');

  return {
    messages: [
      ...(system ? [{ role: 'system' as const, content: system }] : []),
      ...recentMessages,
      { role: 'user', content: input.canonicalText }
    ],
    source,
    style,
    situation,
    speechLevel,
    recentAssistantOpenings
  };
}

function reconnectionInstruction(
  currentInteractionAt: string,
  lastInteractionAt: string | undefined,
  topic: ConversationSituationState['topic'],
  relationshipTone: ConversationStyleState['relationshipTone']
): string | undefined {
  if (!lastInteractionAt || topic !== 'greeting') return undefined;
  const elapsedMs = new Date(currentInteractionAt).getTime() - new Date(lastInteractionAt).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 2.5 * 24 * 60 * 60 * 1_000) return undefined;
  const elapsedDays = Math.max(3, Math.round(elapsedMs / (24 * 60 * 60 * 1_000)));
  const gap = elapsedDays < 14 ? `about ${elapsedDays} days` : elapsedDays < 45 ? 'a few weeks' : 'quite a while';
  if (relationshipTone === 'new') {
    return `The user is returning after ${gap}. Let Seline show that the passage of time registers through a warmer-than-routine welcome, but do not scold or imply that a new acquaintance owed her contact.`;
  }
  return `The user is returning after ${gap}. Let Seline notice the absence once with recognizable relief, delight, fondness, or a brief affectionate complaint appropriate to the relationship. A playful version of “Why did you take so long to come back?” is allowed, but the welcome must clearly outweigh the complaint. Never demand an explanation, imply the user owed contact, guilt-trip them, act abandoned, or keep mentioning the gap after this opening.`;
}

export function buildNaturalRewritePrompt(
  prompt: ConversationPrompt,
  draft: string,
  issues: readonly NaturalnessIssue[]
): ConversationMessage[] {
  const speech = prompt.speechLevel ? `Keep Korean speech consistently ${prompt.speechLevel}.` : '';
  const voice = prompt.source === 'discord_text'
    ? ''
    : 'The result will be spoken aloud, so use plain spoken text without Markdown.';
  return [
    ...prompt.messages,
    { role: 'assistant', content: draft },
    {
      role: 'user',
      content: [
        'Rewrite only the assistant draft above as a more natural continuation of my original message.',
        'Keep its useful meaning and the intended conversational move, but remove assistant-like wording, repetition, unnecessary explanation, and forced questions.',
        prompt.situation.questionStreak >= 2 ? 'The last assistant replies already asked questions, so do not ask another unless a necessary clarification is impossible to avoid.' : '',
        'Treat facts from the original user message as newly learned unless the supplied conversation already established them; remove wording that pretends prior knowledge or shared confirmation.',
        'Do not mention this rewrite request or add new information.',
        speech,
        voice,
        `Quality issues detected: ${issues.join(', ')}.`
      ].filter(Boolean).join(' ')
    }
  ];
}

export function inspectNaturalness(
  text: string,
  prompt: Pick<ConversationPrompt, 'source' | 'speechLevel' | 'recentAssistantOpenings'> & {
    situation?: Pick<ConversationSituationState, 'questionStreak' | 'topic'>;
  }
): NaturalnessIssue[] {
  const normalized = text.trim();
  const issues: NaturalnessIssue[] = [];
  if (!normalized) return issues;
  if (/<think>[\s\S]*?<\/think>|^(?:okay|alright|let me|the user (?:said|wrote)|i need to (?:respond|think))/i.test(normalized)) {
    issues.push('reasoning_leak');
  }
  if (/^(?:좋은 질문(?:이에요|입니다)|그렇군요[.!…]?|이해(?:해요|합니다)[.!…]?|물론(?:이죠|입니다)?[.!…]?|말씀하신 (?:내용|부분)|certainly[.!,:]?|great question[.!,:]?|as an ai\b)/i.test(normalized)) {
    issues.push('assistant_cliche');
  }
  const opening = openingOf(normalized);
  if (similarityKey(opening).length >= 4 && prompt.recentAssistantOpenings.some((recent) => similarityKey(recent) === similarityKey(opening))) {
    issues.push('repeated_opening');
  }
  if (prompt.speechLevel && containsMixedKoreanSpeech(normalized)) issues.push('mixed_speech_level');
  if ((normalized.match(/[?？]/g)?.length ?? 0) >= 2) issues.push('forced_questions');
  if (/[?？]/u.test(normalized) && (prompt.situation?.questionStreak ?? 0) >= 2) issues.push('interview_rhythm');
  if (prompt.source !== 'discord_text' && /```|^\s*[-*]\s+|^\s*#{1,6}\s+/m.test(normalized)) issues.push('voice_unfriendly_format');
  if (prompt.source !== 'discord_text' && Array.from(normalized).length > 260) issues.push('voice_too_long');
  if (/^(?:\[[^\]]+\]\s*)?(?:아[,!?.\s]*(?:진짜|정말)\s+.+(?:네|구나)[.!?…]*|그러게|역시)/u.test(normalized)) {
    issues.push('presumed_shared_context');
  }
  if (prompt.situation?.topic === 'greeting' && /(?:다시\s*인사(?:해|를)|인사해\s*주네|반가워라|greeting me again|また.*挨拶)/iu.test(normalized)) {
    issues.push('detached_greeting');
  }
  return [...new Set(issues)];
}

export function shouldUseReasoning(input: TurnEnvelope): boolean {
  if (conversationSource(input) !== 'discord_text') return false;
  const text = input.canonicalText.trim();
  if (text.length < 40) return false;
  return /(?:분석|비교|설계|원인|왜|어떻게|코드|수학|증명|analy[sz]e|compare|design|explain|debug|why|how)/i.test(text);
}

function normalizeContext(context: string | ConversationPromptContext | undefined): ConversationPromptContext {
  if (!context) return {};
  return typeof context === 'string' ? { instructions: context } : context;
}

function boundedRecentMessages(messages: readonly ConversationMessage[], limit: number): ConversationMessage[] {
  return messages
    .filter((message) => message.role !== 'system' && message.content.trim())
    .slice(-limit)
    .map((message) => ({ ...message, content: message.content.slice(0, 2_000) }));
}

function modalityInstruction(source: TurnInputSource): string | undefined {
  if (source === 'voice_transcript') {
    return 'This is a live voice conversation. Use natural spoken phrasing and usually one concise sentence. Do not use Markdown, lists, headings, URLs, or code blocks unless the user explicitly needs them. Leave room for the user to speak.';
  }
  if (source === 'voice_channel_text') {
    return 'The user typed while already talking with you in a voice channel. Reply aloud. You may make one brief playful remark about the typing, then address the useful point directly. Never quote, recite, or describe the typed message or these instructions.';
  }
  return undefined;
}

function styleInstruction(
  style: ConversationStyleState,
  recentOpenings: readonly string[]
): string | undefined {
  const parts: string[] = [];
  parts.push(responseLanguageInstruction(style.language));
  if (style.speechLevel) {
    parts.push(`Current Korean speech level: ${style.speechLevel}. Keep it consistent throughout the reply and use natural spoken Korean rather than translated English sentence structure.`);
    parts.push('Use Korean laughter, slang, fragments, or emoji more sparingly than the user; never mechanically copy them.');
  }
  parts.push(interactionInstruction(style.interactionType));
  if (style.userEnergy === 'low') parts.push('The user explicitly signaled low energy. Keep the response calm and do not demand extra engagement; do not turn this into a claim that they want to be alone.');
  if (style.userEnergy === 'high') parts.push('The user\'s energy is high. Match some of it without becoming theatrical.');
  if (style.usesShortMessages) parts.push('The user currently prefers short conversational messages; avoid a large polished paragraph.');
  if (style.usesLaughter) parts.push('Light laughter may fit, but use it less often than the user.');
  if (style.usesEmoji) parts.push('At most one emoji may be used when it genuinely fits.');
  if (style.usesSlang) parts.push('Natural casual wording may fit; do not imitate every abbreviation or slang token.');
  if (recentOpenings.length) parts.push(`Avoid reusing these recent assistant openings: ${JSON.stringify(recentOpenings)}.`);
  if (style.desiredLength === 'very_short') parts.push('Prefer one concise spoken sentence.');
  if (style.desiredLength === 'short') parts.push('Prefer one or two concise sentences.');
  return parts.length ? parts.join(' ') : undefined;
}

function responseLanguageInstruction(language: ConversationStyleState['language']): string {
  if (language === 'ko') {
    return 'Reply in Korean only for this turn unless the user explicitly asks for another language. Do not answer in English merely because these instructions are written in English.';
  }
  if (language === 'ja') {
    return 'Reply in Japanese only for this turn unless the user explicitly asks for another language. Do not answer in English merely because these instructions are written in English.';
  }
  return 'Reply in English for this turn unless the user explicitly asks for another language.';
}

function situationInstruction(
  situation: ConversationSituationState,
  style: ConversationStyleState
): string {
  const parts = [
    'Private conversation planning: never reveal these labels or say that you are collecting, profiling, or selecting a response strategy.',
    situationInstructionForTopic(situation.topic),
    relationshipExpressionInstruction(style.relationshipTone),
    `Primary conversational move for this turn: ${situation.selectedMove}. ${moveInstruction(situation.selectedMove)}`,
    'Keep the exchange mutual over time. In casual conversation, alternate among noticing, one gentle follow-up, a brief Seline-side contribution, a remembered callback, playful warmth, practical care, and simple companionship.',
    'Ask at most one new question. Prefer the personal meaning, feeling, or choice already opened by the user over a checklist of who/what/where questions.',
    'Do not ask merely to fill a slot. The memory system, not Seline\'s wording, handles storage; Seline should sound sincerely curious rather than strategic.'
  ];
  if (situation.topic === 'greeting') return parts.join(' ');
  if (situation.questionStreak >= 2) {
    parts.push('The last two assistant replies already ended in questions. Do not ask another one this turn unless a necessary clarification is impossible to avoid; use a reaction, small contribution, callback, or topic offer instead.');
  } else if (situation.questionStreak === 1) {
    parts.push('The previous assistant reply already asked a question. A new question is allowed only if the user clearly opened a fresh thread; otherwise vary the rhythm.');
  }
  if (situation.openness === 'guarded') {
    parts.push('The user appears guarded or is declining the thread. Do not probe. Lower the depth and leave them an easy way to change topics.');
  } else if (situation.openness === 'brief') {
    parts.push('The user is brief. Keep the next step light and easy to answer; do not interpret brevity as permission to ask several questions.');
  } else if (situation.openness === 'engaged') {
    parts.push('The user is engaged. You may respond to one specific detail with a little more depth, while still leaving room for them.');
  }
  if (situation.underexploredPersonalThread) {
    parts.push('A recent personal update from the user appears underexplored. If it connects naturally, make room for it again after handling the current message; do not announce that you remembered it or yank the topic backward.');
  }
  if (situation.memoryOpportunity !== 'none') {
    parts.push(`The current thread naturally exposes a possible ${situation.memoryOpportunity} detail. If the user seems open, go only one layer deeper; never stack questions or mention long-term memory.`);
  }
  if (situation.recentMoves.length) {
    parts.push(`Avoid falling back to these recently used response moves: ${situation.recentMoves.slice(-3).join(', ')}. Keep Seline's character stable while changing the conversational shape.`);
  }
  return parts.join(' ');
}

function situationInstructionForTopic(topic: ConversationSituationState['topic']): string {
  switch (topic) {
    case 'greeting':
      return 'This is a bare greeting. Welcome the user directly with relaxed, unmistakable warmth, then ask exactly one easy, low-pressure question about their present activity, mood, interests, or intended topic. Let warmth come through natural wording instead of evaluating the greeting, announcing an emotion, or performing a reaction; avoid detached phrases like "you greeted me again" or "반가워라". Choose only one question and vary the opening. Favor a question that can naturally reveal a volunteered preference, routine, interest, current plan, or feeling, but never request identifying or sensitive information. Do not invent context or assume the user worked, is tired, has just arrived, or is doing any particular activity.';
    case 'positive_update':
      return 'The user shared something positive. Let their good feeling register, then show curiosity about the part that made it meaningful instead of assuming the reason.';
    case 'daily_update':
      return 'This is ordinary daily life. Treat small details as worth caring about without making them dramatic; one concrete reaction is more intimate than generic encouragement.';
    case 'answering_seline':
      return 'The user is answering something Seline asked. Reward the answer with a specific reaction before deciding whether to deepen, relate, or simply let it land; do not fire the next interview question immediately.';
    case 'about_seline':
      return 'The user is asking about Seline. Answer first with one concrete, persona-consistent detail, opinion, or low-stakes everyday flavor rather than a vague category list. Then leave a natural hook back toward the user when it fits. Never fabricate consequential real-world people, credentials, locations, or history.';
    case 'emotional':
      return 'This is emotionally loaded. Notice the specific feeling and match its weight. When the user says they are tired or worn out, do not close the thread with rest advice alone: first let the feeling land, then—if they have not set a boundary—give them an easy chance to share what made the day tiring. Curiosity should feel protective and optional, not diagnostic; advice comes only after understanding what kind of response the user wants.';
    case 'playful':
      return 'This is playful. Keep momentum with a quick specific reaction, teasing observation, or callback; do not explain the joke or turn it into a questionnaire.';
    case 'task':
      return 'This is a task or technical request. Solve it directly. Relationship warmth may appear as concise attentiveness, never at the cost of accuracy or completion.';
    default:
      return 'This is open conversation. Pick up the most alive detail rather than replying to every clause or defaulting to a generic follow-up.';
  }
}

function relationshipExpressionInstruction(tone: ConversationStyleState['relationshipTone']): string {
  switch (tone) {
    case 'friend':
      return 'Relationship expression: relaxed familiarity. Show care through remembered details, easy honesty, and occasional initiative, not constant reassurance.';
    case 'flirting':
      return 'Relationship expression: warm mutual interest with occasional subtext. Keep affection intermittent and context-specific; most turns should still feel like ordinary life.';
    case 'romantic':
      return 'Relationship expression: secure, understated affection. Let love show through attention, continuity, small concern, and knowing what matters to the user more often than through declarations or pet names.';
    default:
      return 'Relationship expression: warmly welcoming and respectful. Do not assume closeness, but never make the user earn basic warmth or interpret brief replies as rejection.';
  }
}

function moveInstruction(move: ConversationMove): string {
  switch (move) {
    case 'direct_answer':
      return 'Answer the user\'s actual question or request before adding any character flavor.';
    case 'specific_reaction':
      return 'Choose one concrete detail from the user\'s message and react to what it suggests, without merely paraphrasing it.';
    case 'gentle_curiosity':
      return 'Ask one easy, context-specific follow-up about the most meaningful open detail. Do not combine multiple questions.';
    case 'reciprocal_share':
      return 'Contribute one brief Seline-side preference, opinion, association, or harmless everyday detail so the user is not carrying the whole conversation. Keep it concrete and do not invent consequential biography.';
    case 'open_thread_callback':
      return 'Handle the current point, then lightly reconnect an underexplored personal update from recent history. A small observation can work better than explicitly saying you remembered.';
    case 'shared_delight':
      return 'Join the user\'s positive feeling with a fresh, proportionate reaction, then make space for what made it good.';
    case 'emotional_attunement':
      return 'Name or reflect the specific emotional texture indirectly and give it room before advice or questions.';
    case 'empathic_curiosity':
      return 'First acknowledge the user\'s tiredness or strain with a specific, emotionally present reaction. Then ask one easy, optional question about what made them feel that way so they can share the personal context if they want. Do not end the exchange with only generic rest advice.';
    case 'practical_care':
      return 'Offer one small, situation-specific act of care or useful next step without taking over.';
    case 'playful_nudge':
      return 'Use one light tease, vivid comparison, or amusing observation tied to this exact context.';
    case 'quiet_presence':
      return 'Do not probe. Give a simple, warm response that lets the moment breathe and makes no demand on the user.';
    case 'topic_offer':
      return 'Bring in one adjacent topic, choice, or small thought the user can pick up or ignore without pressure.';
  }
}

function conversationSituation(
  input: TurnEnvelope,
  recentMessages: readonly ConversationMessage[],
  style: ConversationStyleState
): ConversationSituationState {
  const text = input.canonicalText.trim();
  const recentAssistantMessages = recentMessages.filter((message) => message.role === 'assistant');
  const recentUserMessages = recentMessages.filter((message) => message.role === 'user');
  const previousUserMessage = recentUserMessages.at(-1)?.content ?? '';
  const questionStreak = consecutiveQuestionStreak(recentAssistantMessages);
  const topic = situationTopic(text, previousUserMessage, recentAssistantMessages.at(-1)?.content ?? '', style);
  const emotionalSignal = emotionSignal(text, style);
  const openness = userOpenness(text);
  const memoryOpportunity = naturalMemoryOpportunity(text);
  const underexploredPersonalThread = hasUnderexploredPersonalThread(recentMessages);
  const recentMoves = recentAssistantMessages.slice(-4).map((message) => inferConversationMove(message.content));
  const selectedMove = selectConversationMove({
    seed: `${input.eventId}:${text}:${recentMessages.length}`,
    topic,
    fatigueDisclosure: isFatigueDisclosure(text),
    openness,
    questionStreak,
    underexploredPersonalThread,
    recentMoves
  });
  return {
    topic,
    emotionalSignal,
    openness,
    memoryOpportunity,
    questionStreak,
    underexploredPersonalThread,
    recentMoves,
    selectedMove
  };
}

function situationTopic(
  text: string,
  previousUserMessage: string,
  previousAssistantMessage: string,
  style: ConversationStyleState
): ConversationSituationState['topic'] {
  const isQuestion = /[?？]\s*$/u.test(text);
  const aboutSeline = isAboutSelineQuestion(text)
    || (isQuestion && isAboutSelineQuestion(previousUserMessage) && Boolean(previousAssistantMessage));
  if (aboutSeline) return 'about_seline';
  if (style.interactionType === 'technical' || style.interactionType === 'request') return 'task';
  if (style.interactionType === 'greeting') return 'greeting';
  if (style.interactionType === 'emotional_support') return 'emotional';
  if (style.interactionType === 'playful') return 'playful';
  if (/[?？]\s*$/u.test(previousAssistantMessage) && !isQuestion) return 'answering_seline';
  if (/(?:좋았|좋아졌|좋은 일|기분 좋|잘 풀|기뻐|신나|행복|재밌었|잘됐|최고|great|good|happy|excited|fun|went well)/iu.test(text)) return 'positive_update';
  if (/(?:오늘|어제|주말|아침|점심|저녁|먹었|마셨|봤어|만났|다녀왔|일했|공부했|today|yesterday|weekend|ate|watched|met|went|worked|studied)/iu.test(text)) return 'daily_update';
  return 'general';
}

function emotionSignal(text: string, style: ConversationStyleState): ConversationSituationState['emotionalSignal'] {
  if (/(?:불안|걱정|무서|초조|anxious|worried|scared|nervous)/iu.test(text)) return 'anxious';
  if (/(?:화나|짜증|속상|서운|슬퍼|우울|angry|annoyed|upset|sad|hurt)/iu.test(text)) return 'upset';
  if (style.userEnergy === 'low') return 'low';
  if (style.interactionType === 'playful') return 'playful';
  if (/(?:좋았|좋은 일|기분 좋|잘 풀|기뻐|신나|행복|재밌|great|good|happy|excited|fun)/iu.test(text)) return 'positive';
  return 'neutral';
}

function userOpenness(text: string): ConversationSituationState['openness'] {
  if (/(?:말하고 싶지|묻지 마|비밀|넘어가자|됐어|괜찮아.*말 안|don'?t want to (?:say|talk)|rather not|none of your business)/iu.test(text)) return 'guarded';
  const length = Array.from(text).length;
  if (length <= 14) return 'brief';
  if (length >= 80 || /(?:왜냐하면|그래서|근데|사실은|because|so |but |actually)/iu.test(text)) return 'engaged';
  return 'normal';
}

function naturalMemoryOpportunity(text: string): ConversationSituationState['memoryOpportunity'] {
  if (/[?？]/u.test(text) || /(?:말하고 싶지|하기 싫|하고 싶진|don'?t want to|rather not)/iu.test(text)) return 'none';
  if (/(?:좋아해|좋아함|싫어해|선호|최애|취향|favorite|prefer|love |hate |enjoy)/iu.test(text)) return 'preference';
  if (/(?:친구|가족|엄마|아빠|형|누나|언니|오빠|동료|선배|후배|friend|family|mom|dad|coworker|partner)/iu.test(text)) return 'person';
  if (/(?:보통|자주|항상|매일|주말마다|루틴|usually|often|always|every day|routine)/iu.test(text)) return 'routine';
  if (/(?:때마다|하면.*(?:편해|진정|힘들|기분)|when .* feel|helps me|makes me feel)/iu.test(text)) return 'emotion_pattern';
  if (/(?:목표|언젠가|계획|하고 싶|되고 싶|goal|someday|plan to|want to become)/iu.test(text)) return 'plan';
  if (/(?:중요|소중|가치|원칙|믿어|important|matters|value|believe)/iu.test(text)) return 'value';
  return 'none';
}

function hasUnderexploredPersonalThread(messages: readonly ConversationMessage[]): boolean {
  return messages
    .filter((message) => message.role === 'user')
    .slice(-5)
    .some((message) => {
      const text = message.content.trim();
      return !/[?？]/u.test(text)
        && Array.from(text).length <= 180
        && /(?:오늘|어제|주말|좋았|기뻐|신나|힘들|피곤|속상|걱정|친구|가족|회사|학교|먹었|봤어|만났|today|yesterday|weekend|good|happy|tired|upset|worried|friend|family|work|school|ate|watched|met)/iu.test(text);
    });
}

function consecutiveQuestionStreak(messages: readonly ConversationMessage[]): number {
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!/[?？]\s*$/u.test(messages[index].content.trim())) break;
    count += 1;
  }
  return count;
}

function inferConversationMove(text: string): ConversationMove {
  if (/[?？]/u.test(text)) return 'gentle_curiosity';
  if (/(?:지난번|전에 말|기억나|last time|you mentioned|remember)/iu.test(text)) return 'open_thread_callback';
  if (/(?:해봐|하는 게 어때|챙겨|쉬어|try |maybe you could|make sure)/iu.test(text)) return 'practical_care';
  if (/(?:ㅋ{2,}|ㅎ{2,}|농담|장난|웃|lol|haha|teas)/iu.test(text)) return 'playful_nudge';
  if (/(?:^|\s)(?:나는|난|내 취향|나라면|나도|I |I'd|my preference)/iu.test(text)) return 'reciprocal_share';
  if (/(?:다행|잘됐|좋네|기쁘|glad|nice|love that)/iu.test(text)) return 'shared_delight';
  return 'specific_reaction';
}

function selectConversationMove(input: {
  seed: string;
  topic: ConversationSituationState['topic'];
  fatigueDisclosure: boolean;
  openness: ConversationSituationState['openness'];
  questionStreak: number;
  underexploredPersonalThread: boolean;
  recentMoves: readonly ConversationMove[];
}): ConversationMove {
  let candidates: ConversationMove[];
  switch (input.topic) {
    case 'task': candidates = ['direct_answer']; break;
    case 'greeting': candidates = ['gentle_curiosity']; break;
    case 'positive_update': candidates = ['shared_delight', 'gentle_curiosity', 'playful_nudge', 'specific_reaction']; break;
    case 'daily_update':
    case 'answering_seline': candidates = ['specific_reaction', 'reciprocal_share', 'gentle_curiosity', 'playful_nudge']; break;
    case 'about_seline': candidates = input.underexploredPersonalThread
      ? ['reciprocal_share', 'open_thread_callback', 'playful_nudge']
      : ['reciprocal_share', 'gentle_curiosity', 'playful_nudge']; break;
    case 'emotional': candidates = input.fatigueDisclosure && input.openness !== 'guarded' && input.questionStreak < 2
      ? ['empathic_curiosity']
      : ['emotional_attunement', 'practical_care', 'gentle_curiosity', 'quiet_presence']; break;
    case 'playful': candidates = ['playful_nudge', 'reciprocal_share', 'specific_reaction']; break;
    default: candidates = ['specific_reaction', 'gentle_curiosity', 'reciprocal_share', 'topic_offer']; break;
  }
  if (input.openness === 'guarded' || input.questionStreak >= 2) {
    candidates = candidates.filter((move) => move !== 'gentle_curiosity' && move !== 'empathic_curiosity' && move !== 'open_thread_callback');
  }
  const recent = new Set(input.recentMoves.slice(-2));
  const fresh = candidates.filter((move) => !recent.has(move));
  if (fresh.length) candidates = fresh;
  if (!candidates.length) candidates = ['quiet_presence'];
  return candidates[stableIndex(input.seed, candidates.length)];
}

function isFatigueDisclosure(text: string): boolean {
  return /(?:피곤|지쳤|기진맥진|녹초|힘들었|힘들어|tired|exhausted|worn out|drained|rough day)/iu.test(text);
}

function isAboutSelineQuestion(text: string): boolean {
  return /(?:너는|넌|너도|셀린(?:은|이는)?|you|yourself)/iu.test(text)
    && /(?:뭐|무엇|어떤|어때|어떻게|했|봤|좋아|싫어|생각|느껴|what|how|did|do you|like|think|feel)/iu.test(text);
}

function stableIndex(seed: string, length: number): number {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % Math.max(1, length);
}

function conversationStyle(
  input: TurnEnvelope,
  recentMessages: readonly ConversationMessage[],
  source: TurnInputSource
): ConversationStyleState {
  const userSamples = [...recentMessages.filter((message) => message.role === 'user').slice(-3).map((message) => message.content), input.canonicalText];
  const sample = userSamples.join(' ');
  const language = input.personalPreferences?.language === 'ja' || /[\u3040-\u30ff]/u.test(sample)
    ? 'ja'
    : input.personalPreferences?.language === 'ko' || /[\uac00-\ud7a3]/u.test(sample)
      ? 'ko'
      : 'en';
  const relationship = input.personalPreferences?.relationshipTone;
  const relationshipTone = relationship === 'friend' || relationship === 'flirting' || relationship === 'romantic'
    ? relationship
    : 'new';
  const averageLength = userSamples.reduce((sum, value) => sum + Array.from(value).length, 0) / Math.max(1, userSamples.length);
  const usesLaughter = /(?:ㅋ{2,}|ㅎ{2,}|(?:^|\s)(?:lol|lmao)(?:\s|$))/iu.test(sample);
  const usesEmoji = /\p{Extended_Pictographic}/u.test(sample);
  const usesSlang = /(?:ㅇㅇ|ㄴㄴ|ㄱㄱ|ㄹㅇ|개웃|존맛|했음|같음|임\b|fr\b|ngl\b|idk\b)/iu.test(sample);
  const highEnergy = /[!?！？]{2,}|ㅋ{3,}|ㅎ{3,}|\p{Extended_Pictographic}.*\p{Extended_Pictographic}/u.test(input.canonicalText);
  const lowEnergy = /(?:피곤|지쳤|힘들|우울|속상|외로|하기 싫|tired|exhausted|sad|lonely|rough day)/iu.test(input.canonicalText);
  return {
    language,
    speechLevel: language === 'ko' ? koreanSpeechLevel(input, recentMessages) : undefined,
    interactionType: interactionType(input),
    userEnergy: lowEnergy ? 'low' : highEnergy ? 'high' : 'normal',
    desiredLength: source !== 'discord_text'
      ? 'very_short'
      : input.personalPreferences?.replyLength === 'short' || averageLength < 45
        ? 'short'
        : 'normal',
    relationshipTone,
    usesShortMessages: averageLength < 45,
    usesLaughter,
    usesEmoji,
    usesSlang
  };
}

function interactionType(input: TurnEnvelope): ConversationStyleState['interactionType'] {
  const text = input.canonicalText.trim();
  if (/^(?:안녕|하이|ㅎㅇ|좋은 (?:아침|저녁)|hello|hi|hey|おはよう|こんにちは|こんばんは)(?:\s+(?:셀린|seline))?[!~.ㅋㅎ\s]*$/iu.test(text)) return 'greeting';
  if (/(?:피곤|지쳤|힘들|우울|속상|외로|무서|불안|tired|exhausted|sad|lonely|anxious|scared)/iu.test(text)) return 'emotional_support';
  if (/(?:ㅋ{2,}|ㅎ{2,}|농담|장난|웃겨|lol|lmao|joke)/iu.test(text)) return 'playful';
  if (shouldUseReasoning(input) || /(?:에러|버그|코드|설정|구현|API|database|typescript|python|debug)/iu.test(text)) return 'technical';
  if (/[?？]$/.test(text) || /^(?:왜|어떻게|뭐|무슨|어디|언제|누가|why|how|what|where|when|who)\b/iu.test(text)) return 'question';
  if (/(?:해줘|해주세요|해 봐|만들어|알려줘|보여줘|please|could you|can you)/iu.test(text)) return 'request';
  return 'casual_chat';
}

function interactionInstruction(type: ConversationStyleState['interactionType']): string {
  switch (type) {
    case 'greeting': return 'This is a bare greeting. Reply in one or two short, natural sentences. Welcome the user directly and warmly before taking the lead with exactly one easy question. Do not comment on the fact that they greeted Seline or infer their circumstances.';
    case 'emotional_support': return 'This is an emotional moment. Acknowledge the specific feeling without generic therapy language, rushing into solutions, or asking several questions.';
    case 'playful': return 'This is playful conversation. A light witty reaction is welcome; do not explain the joke.';
    case 'technical': return 'This is a factual or technical turn. Answer accurately and directly before adding any personality.';
    case 'question': return 'Answer the question first. Add a follow-up only if it materially helps.';
    case 'request': return 'Handle the request directly without a customer-service preamble.';
    default: return 'This is casual conversation. Use one specific reaction and ask a question only when it naturally moves the exchange forward.';
  }
}

function koreanSpeechLevel(
  input: TurnEnvelope,
  recentMessages: readonly ConversationMessage[]
): 'polite' | 'casual' | undefined {
  const preferredLanguage = input.personalPreferences?.language;
  const sample = [...recentMessages.filter((message) => message.role === 'user').slice(-3).map((message) => message.content), input.canonicalText].join(' ');
  if (preferredLanguage !== 'ko' && !/[\uac00-\ud7a3]/u.test(sample)) return undefined;
  const polite = (sample.match(/(?:요|니다|까요|세요|어요|아요|죠)(?:[.!?~ㅋㅎ\s]|$)/gu) ?? []).length;
  const casual = (sample.match(/(?:야|지|네|냐|어|아|임|함|됨|했음|같음)(?:[.!?~ㅋㅎ\s]|$)/gu) ?? []).length;
  // Do not switch to casual speech from one short fragment; require a clear pattern.
  return casual >= 2 && casual > polite * 1.5 ? 'casual' : 'polite';
}

function containsMixedKoreanSpeech(text: string): boolean {
  const polite = /(?:요|니다|까요|세요|어요|아요|죠)(?:[.!?~ㅋㅎ\s]|$)/u.test(text);
  const casual = /(?:야|냐|했어|할게|해봐|거야|맞아|괜찮아|모르겠어)(?:[,.!?，。~ㅋㅎ\s]|$)/u.test(text);
  return polite && casual;
}

function openingOf(text: string): string {
  return text.trim().split(/(?<=[.!?。！？])\s+|\n/u, 1)[0]?.trim().slice(0, 60) ?? '';
}

function similarityKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 24);
}
