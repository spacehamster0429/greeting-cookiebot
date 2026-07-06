# Greeting Cookiebot

Discord 서버의 입장·퇴장 인사를 담당하는 작은 봇입니다. 서버별 채널과 메시지 템플릿을 설정할 수 있습니다

### 쿠키봇 소개 페이지: https://bots.serika.duckdns.org/cookiebot/
###### 본 봇은 개인 서버에서 테스트 목적으로 운영되며, 상시 가동이나 지속적인 서비스 제공을 보장하지 않습니다.

## 기능

- 입장·퇴장 인사 채널 및 메시지 설정
- `{member}`, `{username}`, `{displayname}`, `{guild}`, `{channel}`, `{member_count}` 등의 플레이스홀더
- 인사 미리보기·테스트·초기화
- 서버별 기능 등록·해제와 관리자 권한 검증
- SQLite WAL 저장, 멘션 제한, 정상 종료 처리
- Docker/Podman Compose 실행 예제

## Discord 설정

Discord Developer Portal에서 Bot의 **Server Members Intent**를 활성화해야 합니다. 봇에는 인사 채널을 보고 메시지를 보낼 권한이 필요합니다.

## 실행

Node.js 22 이상이 필요합니다.

```bash
cp .env.example .env
npm ci
npm run check
npm start
```

환경변수:

```dotenv
DISCORD_TOKEN=your_discord_bot_token_here
OWNER_ID=
COOKIEBOT_DB_PATH=./data/cookiebot.db
```

`OWNER_ID`는 시작·종료 알림 DM을 받을 봇 소유자 ID이며 선택 사항입니다.

## 컨테이너

```bash
mkdir -p data logs
podman compose up -d --build
```

Compose는 `.env`를 읽고 DB를 `data/`, 로그용 디렉터리를 `logs/`에 보존합니다. 두 디렉터리와 `.env`는 Git에서 제외됩니다.

## 명령어

- `/서버등록`, `/서버등록해제`
- `/입장로그채널설정`, `/퇴장로그채널설정`
- `/입장메시지설정`, `/퇴장메시지설정`
- `/인사기능설정`, `/인사설정보기`, `/인사채널자동설정`
- `/인사미리보기`, `/인사테스트`, `/인사메시지초기화`
- `/도움말`, `/핑`

## 데이터와 개인정보

봇은 로컬 SQLite DB에 Discord 서버 ID, 설정한 채널 ID, 인사 활성화 상태와 사용자 지정 메시지를 저장합니다. DB와 WAL 파일은 시작 시 권한 `0600`으로 제한합니다. 운영 로그에는 이벤트 처리를 위해 서버·사용자 ID가 기록될 수 있습니다. 외부 분석이나 원격 텔레메트리는 사용하지 않습니다.

저장소에는 운영 토큰, 실제 DB, 로그 또는 사용자 데이터가 포함되지 않습니다. `.env`, `data/`, `logs/`는 Git 및 컨테이너 빌드 컨텍스트에서 제외됩니다.

## 라이선스

Copyright 2026 우주햄찌.

Apache License 2.0에 따라 배포됩니다. 자세한 내용은 [LICENSE](LICENSE)와 [NOTICE](NOTICE)를 확인하세요.
