import { SlashCommandBuilder } from 'discord.js';

const JA = {
  root: 'SelineとLoveAIを操作します。', help: 'LoveAIコマンドのヘルプを表示します。', chat: 'Selineにテキストメッセージを送ります。', message: '送信するメッセージです。',
  sns: 'SNS風または標準のテキスト返信を選択します。', textStyle: 'テキスト返信のスタイルです。', snsOn: 'SNSスタイル（既定）', standard: '標準テキスト', chatMode: 'このチャンネルのSelineテキストチャットをオンまたはオフにします。', chatBehavior: 'このチャンネルでSelineがテキストに応答するかどうかです。', chatOn: 'オン', chatOff: 'オフ',
  usage: '残りのトークン利用可能率を表示します。', game: 'Selineと三目並べをします。', model: '利用可能なモデルを表示、またはサーバーのモデルを変更します。', modelName: '許可されたGeminiモデル名です。',
  join: 'Selineを現在のボイスチャンネルに参加させます。', leave: 'Selineをボイスチャンネルから退出させます。', voiceMode: '自動追従または手動参加を選択します。', joinBehavior: 'このサーバーの音声参加方法です。', automatic: '自動追従', manual: '手動（/loveai voicejoin）',
  recognition: '現在のボイスチャンネルの音声認識言語を選択します。', recognitionChoice: 'ボイスチャットで認識する言語です。', detect: '自動検出（推奨）', english: '英語', korean: '韓国語', japanese: '日本語'
} as const;

const publicLoveAiCommand = new SlashCommandBuilder()
    .setName('loveai')
    .setDescription('Seline and LoveAI controls.')
    .setDescriptionLocalizations({ ko: '셀린과 LoveAI를 제어합니다.', ja: JA.root })
    .addSubcommand((s) => s.setName('help').setDescription('Show LoveAI command help.').setDescriptionLocalizations({ ko: 'LoveAI 명령어 도움말을 봅니다.', ja: JA.help }))
    .addSubcommand((s) => s.setName('chat').setDescription('Send a text message to Seline.').setDescriptionLocalizations({ ko: '셀린에게 텍스트 메시지를 보냅니다.', ja: JA.chat }).addStringOption((o) => o.setName('message').setDescription('Message to send.').setDescriptionLocalizations({ ko: '보낼 메시지입니다.', ja: JA.message }).setRequired(true).setMaxLength(1_500)))
    .addSubcommand((s) => s.setName('snsmode').setDescription('Choose relaxed SNS-style text replies or standard text replies.').setDescriptionLocalizations({ ko: 'SNS 스타일 또는 기본 텍스트 답변을 선택합니다.', ja: JA.sns }).addStringOption((o) => o.setName('mode').setDescription('Your text reply style.').setDescriptionLocalizations({ ko: '텍스트 답변 스타일입니다.', ja: JA.textStyle }).setRequired(true).addChoices({ name: 'SNS style (default)', name_localizations: { ko: 'SNS 스타일 (기본)', ja: JA.snsOn }, value: 'on' }, { name: 'Standard text', name_localizations: { ko: '기본 텍스트', ja: JA.standard }, value: 'off' })))
    .addSubcommand((s) => s.setName('usage').setDescription('Show your remaining usage percentage.').setDescriptionLocalizations({ ko: '남은 사용량 퍼센트를 봅니다.', ja: JA.usage }))
    .addSubcommand((s) => s.setName('chatmode').setDescription('Turn Seline text chat on or off for this channel.').setDescriptionLocalizations({ ko: '이 채널의 셀린 텍스트 채팅을 켜거나 끕니다.', ja: JA.chatMode }).addStringOption((o) => o.setName('mode').setDescription('Whether Seline replies to text in this channel.').setDescriptionLocalizations({ ko: '이 채널에서 셀린이 텍스트에 답변할지 여부입니다.', ja: JA.chatBehavior }).setRequired(true).addChoices({ name: 'On', name_localizations: { ko: '켜기', ja: JA.chatOn }, value: 'on' }, { name: 'Off', name_localizations: { ko: '끄기', ja: JA.chatOff }, value: 'off' })))
    .addSubcommand((s) => s.setName('tictactoe').setDescription('Play tic-tac-toe against Seline.').setDescriptionLocalizations({ ko: '셀린과 틱택토를 플레이합니다.', ja: JA.game }))
    .addSubcommand((s) => s.setName('model').setDescription('Show available models or switch the server model.').setDescriptionLocalizations({ ko: '사용 가능한 모델을 보거나 서버 모델을 바꿉니다.', ja: JA.model }).addStringOption((o) => o.setName('model').setDescription('Allowed Gemini model name.').setDescriptionLocalizations({ ko: '허용된 Gemini 모델 이름입니다.', ja: JA.modelName }).setRequired(false)))
    .addSubcommand((s) => s.setName('voicejoin').setDescription('Make Seline join your current voice channel.').setDescriptionLocalizations({ ko: '셀린을 현재 음성 채널에 참여시킵니다.', ja: JA.join }))
    .addSubcommand((s) => s.setName('voiceleave').setDescription('Make Seline leave the voice channel.').setDescriptionLocalizations({ ko: '셀린을 음성 채널에서 나가게 합니다.', ja: JA.leave }))
    .addSubcommand((s) => s.setName('voicemode').setDescription('Choose automatic follow or manual voice joining.').setDescriptionLocalizations({ ko: '자동 또는 수동 음성 참여를 선택합니다.', ja: JA.voiceMode }).addStringOption((o) => o.setName('mode').setDescription('Voice join behavior for this server.').setDescriptionLocalizations({ ko: '이 서버의 음성 참여 방식입니다.', ja: JA.joinBehavior }).setRequired(true).addChoices({ name: 'Automatic follow', name_localizations: { ko: '자동 따라가기', ja: JA.automatic }, value: 'auto' }, { name: 'Manual (/loveai voicejoin)', name_localizations: { ko: '수동 (/loveai voicejoin)', ja: JA.manual }, value: 'manual' })))
    .addSubcommand((s) => s.setName('language').setDescription('Choose the speech-recognition language for your current voice channel.').setDescriptionLocalizations({ ko: '현재 음성 채널의 음성 인식 언어를 선택합니다.', ja: JA.recognition }).addStringOption((o) => o.setName('mode').setDescription('Language to recognize in voice chat.').setDescriptionLocalizations({ ko: '음성 채팅에서 인식할 언어입니다.', ja: JA.recognitionChoice }).setRequired(true).addChoices({ name: 'Automatic detection (recommended)', name_localizations: { ko: '자동 감지 (권장)', ja: JA.detect }, value: 'auto' }, { name: 'English', name_localizations: { ko: '영어', ja: JA.english }, value: 'en' }, { name: 'Korean', name_localizations: { ko: '한국어', ja: JA.korean }, value: 'ko' }, { name: 'Japanese', name_localizations: { ko: '일본어', ja: JA.japanese }, value: 'ja' })))
;


const memoryCommand = new SlashCommandBuilder()
  .setName('memory')
  .setDescription('Manage your private long-term memory.')
  .setDescriptionLocalizations({ ko: '개인 장기기억을 관리합니다.', ja: '個人の長期記憶を管理します。' })
  .addSubcommand((s) => s.setName('on').setDescription('Enable private long-term memory.').setDescriptionLocalizations({ ko: '개인 장기기억을 켭니다.' }))
  .addSubcommand((s) => s.setName('off').setDescription('Disable and erase private long-term memory.').setDescriptionLocalizations({ ko: '개인 장기기억을 끄고 삭제합니다.' }))
  .addSubcommand((s) => s.setName('list').setDescription('List your private memories and quota.').setDescriptionLocalizations({ ko: '개인 기억과 사용량을 봅니다.' }))
  .addSubcommand((s) => s.setName('forget').setDescription('Erase all of your private memories.').setDescriptionLocalizations({ ko: '개인 기억을 모두 삭제합니다.' }))
  .addSubcommand((s) => s.setName('pin').setDescription('Pin one memory.').setDescriptionLocalizations({ ko: '기억 하나를 고정합니다.' }).addStringOption((o) => o.setName('id').setDescription('Memory ID from /memory list.').setRequired(true)))
  .addSubcommand((s) => s.setName('unpin').setDescription('Unpin one memory.').setDescriptionLocalizations({ ko: '기억 하나의 고정을 해제합니다.' }).addStringOption((o) => o.setName('id').setDescription('Memory ID from /memory list.').setRequired(true)))
  .addSubcommand((s) => s.setName('delete').setDescription('Delete one memory.').setDescriptionLocalizations({ ko: '기억 하나를 삭제합니다.' }).addStringOption((o) => o.setName('id').setDescription('Memory ID from /memory list.').setRequired(true)));
export const slashCommands = [publicLoveAiCommand.toJSON(), memoryCommand.toJSON()];
