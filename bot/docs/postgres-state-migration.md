# Discord bot PostgreSQL state migration

`bot/.env`의 `BOT_DATABASE_URL`에는 **봇 상태 DB** URL을 설정한 뒤 실행한다. 이 URL은 웹 API 주소(`BOT_API_BASE_URL`)도, 웹 DB URL도 아니다.

```powershell
cd bot
npx tsx apps/discord-bot/src/scripts/migrate-local-sqlite-to-postgres.ts data/seline-local.sqlite data/seline-console-settings.json
```

가져오기는 두 로컬 원본을 읽기 전용으로 사용한다. 필요한 `bot_*` 테이블을 만들고 크레딧, 사용량, 최근 대화, 사용자·음성 설정, 콘솔 설정을 upsert한다. `seline-local.sqlite`와 콘솔 JSON 파일을 삭제하거나 초기화하지 않는다.

성공 후 봇을 다시 시작한다.

```powershell
cd bot
npm run start --workspace=@anime/discord-bot
```
