#!/usr/bin/env bash

mkdir -p logs

while true; do
    TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
    npm start 2>&1 | tee -a logs/bot_$TIMESTAMP.log
    STATUS=${PIPESTATUS[0]}
    if [ "$STATUS" -eq 0 ]; then
        echo "[i] 봇이 정상 종료되어 자동 재시작을 중단합니다." | tee -a logs/bot_$TIMESTAMP.log
        exit 0
    fi
    echo "[!] 봇이 죽었습니다. 5초 후 자동 재시작" | tee -a logs/bot_$TIMESTAMP.log
    sleep 5
done
