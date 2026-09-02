import type { CommandLanguage } from './command-language.js';

/** Help shown inside Discord; it never documents process-local commands. */
export function discordLoveAiHelp(language: CommandLanguage, includeManagerControls = false): string {
  const help = FORMATTED_HELP[language];
  return includeManagerControls ? [help.member, help.manager].join('\n\n') : help.member;
}

type DiscordHelp = { member: string; manager: string };

const FORMATTED_HELP: Record<CommandLanguage, DiscordHelp> = {
  'en-US': {
    member: [
      '**LoveAI Help**',
      'Mention Seline in a text channel, or use a command below.',
      '',
      '**💬 Text chat**',
      '- `/loveai chat message:<text>` — Send Seline a message.',
      '- `/loveai chatmode mode:on|off` — Turn text replies on or off in this channel.',
      '- `/loveai snsmode mode:on|off` — Choose short SNS-style or standard replies.',
      '- `/loveai tictactoe` — Play an interactive game of tic-tac-toe.',
      '',
      '**🔊 Voice chat**',
      '- `/loveai voiceleave` — End the active voice session.',
      '- `/loveai language mode:<auto|en|ko|ja>` — Set this channel’s speech recognition.',
      '',
      '**⚙️ Usage**',
      '- `/loveai usage` — View your remaining monthly token percentage.',
      '',
      '**🧠 Private memory**',
      '- `/memory on|off|list|forget` — Enable, inspect, or erase your memories.',
      '- `/memory pin|unpin|delete id:<memory-id>` — Manage one memory from the private list.',
      '',
      '**🔐 Available to everyone**',
      '- `voiceleave` and `chatmode` can be used by anyone in the server.'
    ].join('\n'),
    manager: [
      '**🛡 Server-management commands**',
      '- `/loveai voicejoin` — Bring Seline to your current voice channel.',
      '- `/loveai voicemode mode:auto|manual` — Set automatic or manual voice joining.',
      '- `/loveai model` — View models available to this server.',
      '- `/loveai model model:<name>` — Change the server’s AI model.'
    ].join('\n')
  },
  ko: {
    member: [
      '**🌙 LoveAI 사용 안내**',
      '셀린과 편하게 이야기해 볼까요? 텍스트 채널에서 셀린을 멘션하거나 아래 명령어를 골라 주세요.',
      '',
      '**💬 가볍게 대화하기**',
      '- `/loveai chat message:<내용>` — 셀린에게 하고 싶은 이야기를 보내요.',
      '- `/loveai chatmode mode:on|off` — 이 채널에서 셀린의 답장을 켜거나 잠시 쉬게 해요.',
      '- `/loveai snsmode mode:on|off` — 짧은 SNS 스타일 또는 기본 답변을 골라요.',
      '- `/loveai tictactoe` — 셀린과 버튼 보드로 틱택토 한 판 해요.',
      '',
      '**🎧 목소리로 함께하기**',
      '- `/loveai voiceleave` — 진행 중인 음성 채팅을 마무리해요.',
      '- `/loveai language mode:<auto|en|ko|ja>` — 이 채널의 음성 인식 언어를 골라요.',
      '',
      '**✨ 사용량**',
      '- `/loveai usage` — 이번 달 남은 토큰 사용량을 퍼센트로 확인해요.',
      '',
      '**🧠 나만의 기억**',
      '- `/memory on|off|list|forget` — 기억을 켜고, 살펴보고, 비울 수 있어요.',
      '- `/memory pin|unpin|delete id:<기억-ID>` — 비공개 목록의 기억 하나를 정리해요.',
      '',
      '**🔓 서버 모두가 쓸 수 있어요**',
      '- 필요할 때 누구나 `voiceleave`, `chatmode`를 사용할 수 있어요.'
    ].join('\n'),
    manager: [
      '**🛠 서버 설정 (관리자)**',
      '- `/loveai voicejoin` — 셀린을 현재 음성 채널로 불러요.',
      '- `/loveai voicemode mode:auto|manual` — 자동 또는 수동 음성 참여를 골라요.',
      '- `/loveai model` — 이 서버에서 사용할 수 있는 모델을 살펴봐요.',
      '- `/loveai model model:<이름>` — 이 서버의 AI 모델을 바꿔요.'
    ].join('\n')
  },
  ja: {
    member: [
      '**LoveAI ヘルプ**',
      'テキストチャンネルでSelineをメンションするか、以下のコマンドを使ってください。',
      '',
      '**💬 テキストチャット**',
      '- `/loveai chat message:<テキスト>` — Selineにメッセージを送ります。',
      '- `/loveai chatmode mode:on|off` — このチャンネルのテキスト返信をオンまたはオフにします。',
      '- `/loveai snsmode mode:on|off` — SNS風または標準の返信を選びます。',
      '- `/loveai tictactoe` — Selineとインタラクティブな三目並べをします。',
      '',
      '**🔊 ボイスチャット**',
      '- `/loveai voiceleave` — 進行中のボイスセッションを終了します。',
      '- `/loveai language mode:<auto|en|ko|ja>` — このチャンネルの音声認識言語を設定します。',
      '',
      '**⚙️ 利用状況**',
      '- `/loveai usage` — 今月の残りトークン利用率を確認します。',
      '',
      '**🧠 個人メモリ**',
      '- `/memory on|off|list|forget` — メモリを有効化、確認、全削除します。',
      '- `/memory pin|unpin|delete id:<メモリID>` — 非公開リストのメモリを個別管理します。',
      '',
      '**🔐 誰でも利用可能**',
      '- サーバーの誰でも `voiceleave` と `chatmode` を使えます。'
    ].join('\n'),
    manager: [
      '**🛡 サーバー管理者コマンド**',
      '- `/loveai voicejoin` — Selineを現在のボイスチャンネルに呼びます。',
      '- `/loveai voicemode mode:auto|manual` — 自動または手動のボイス参加を選びます。',
      '- `/loveai model` — このサーバーで利用可能なAIモデルを確認します。',
      '- `/loveai model model:<名前>` — このサーバーのAIモデルを変更します。'
    ].join('\n')
  }
};