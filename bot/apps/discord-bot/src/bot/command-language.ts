/**
 * One registry owns every mapping derived from a website language. Adding a
 * language here makes parsing, STT, TTS, and command copy share the same code.
 */
export const commandLanguageDefinitions = {
  'en-US': {
    aliases: ['en', 'enus', 'english', 'eng', '영어'],
    recognitionLanguage: 'en',
    voiceProfileLanguage: 'en-US'
  },
  ko: {
    aliases: ['ko', 'kokr', 'korean', 'kor', 'kr', '한국어', '한글', '한국말'],
    recognitionLanguage: 'ko',
    voiceProfileLanguage: 'ko'
  },
  ja: {
    aliases: ['ja', 'jajp', 'japanese', 'jpn', 'jp', '일본어', '日本語', 'にほんご'],
    recognitionLanguage: 'ja',
    voiceProfileLanguage: 'ja'
  }
} as const;

/** Language codes shared by website preferences, command copy, and voice. */
export type CommandLanguage = keyof typeof commandLanguageDefinitions;

export const commandLanguages = Object.keys(commandLanguageDefinitions) as CommandLanguage[];

export type LocalizedText = Record<CommandLanguage, string>;

const japaneseFallbacks: Record<string, string> = {
  'Choose either SNS style or standard text.': 'SNSスタイルまたは標準テキストを選択してください。',
  'SNS-style text is on. Longer replies will arrive as short messages.': 'SNSスタイルを有効にしました。長い返信は短いメッセージに分けて届きます。',
  'SNS-style text is off. Replies will use standard wording and stay together.': 'SNSスタイルを無効にしました。返信は標準的な一つのメッセージで届きます。',
  'Model selection is managed by the service right now.': 'モデルの選択は現在サービス側で管理されています。',
  'Available models': '利用可能なモデル',
  'active': '使用中',
  'Choose automatic detection, English, or Korean.': '自動検出、英語、韓国語、または日本語を選択してください。',
  'automatic detection': '自動検出',
  'English': '英語',
  'Only a server administrator can change the voice join mode.': 'ボイス参加モードを変更できるのはサーバー管理者だけです。',
  'Choose automatic or manual voice mode.': '自動または手動のボイスモードを選択してください。',
  'Seline left the voice channel.': 'Selineはボイスチャンネルから退出しました。',
  'There is no active voice session in this server.': 'このサーバーにはアクティブなボイスセッションがありません。',
  'Only a server administrator can change the bot model because it affects the whole server.': 'ボットモデルの変更はサーバー全体に影響するため、サーバー管理者だけが実行できます。',
  'That model is not allowed. Use /loveai model to see the available models.': 'そのモデルは使用できません。`/loveai model` で利用可能なモデルを確認してください。',
  'Usage tracking is not available until the production billing service is connected.': '本番の請求サービスが接続されるまで、利用状況の追跡は利用できません。',
  'Voice join mode: **automatic**. Seline will follow server managers who join a voice channel.': 'ボイス参加モード: **自動**。Selineはボイスチャンネルに入ったサーバー管理者を自動追従します。',
  'Voice join mode: **manual**. Use /loveai voicejoin when you want Seline in your current voice channel.': 'ボイス参加モード: **手動**。現在のボイスチャンネルにSelineを呼ぶには `/loveai voicejoin` を使用します。',
  'Usage': '利用状況'
};

export function commandText(language: CommandLanguage, english: string, korean: string, japanese?: string): string {
  if (language === 'ko') return korean;
  if (language === 'ja') return japanese ?? japaneseFallback(english);
  return english;
}
function japaneseFallback(text: string): string {
  const exact = japaneseFallbacks[text];
  if (exact) return exact;
  const modelChanged = text.match(/^Seline now uses \*\*(.+)\*\* for text and voice replies\.$/);
  if (modelChanged) return `Selineはテキストと音声の返信に**${modelChanged[1]}**を使用します。`;
  const joined = text.match(/^Seline joined your voice channel\. \(channel: (.+)\)$/);
  if (joined) return `Selineはボイスチャンネルに参加しました。（チャンネル: ${joined[1]}）`;
  const recognition = text.match(/^Voice recognition for \*\*(.+)\*\* is now \*\*(.+)\*\*\.$/);
  if (recognition) return `**${recognition[1]}**の音声認識を**${recognition[2]}**に設定しました。`;
  if (text === ' Applied to the active session immediately.') return '現在のセッションにすぐ適用しました。';
  if (text === ' It will apply when Seline joins this channel.') return 'Selineがこのチャンネルに参加すると適用されます。';
  return text;
}

export function commandLanguageFromDiscordLocale(locale: string | null | undefined): CommandLanguage | undefined {
  const normalized = locale?.toLowerCase().replace('_', '-') ?? '';
  if (normalized === 'ko' || normalized.startsWith('ko-')) return 'ko';
  if (normalized === 'ja' || normalized.startsWith('ja-')) return 'ja';
  return undefined;
}

export function commandLanguageFromValue(value: unknown): CommandLanguage | undefined {
  const normalized = typeof value === 'string'
    ? value.normalize('NFKC').trim().toLowerCase().replace(/[\s_-]+/g, '')
    : '';
  if (!normalized) return undefined;
  return commandLanguages.find((language) =>
    (commandLanguageDefinitions[language].aliases as readonly string[]).includes(normalized)
  );
}

export function voiceRecognitionLanguageFor(language: CommandLanguage): 'en' | 'ko' | 'ja' {
  return commandLanguageDefinitions[language].recognitionLanguage;
}

export function voiceProfileLanguageFor(language: CommandLanguage): 'en-US' | 'ko' | 'ja' {
  return commandLanguageDefinitions[language].voiceProfileLanguage;
}
