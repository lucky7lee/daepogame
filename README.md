# 💣 탱크 클래시 (Tank Clash)

PC 및 안드로이드 스마트폰·스마트탭 화면에 최적화된 **1~4인 턴제 대포 게임 (탱크 클래시 / Tank Clash)**입니다.

## 🌐 온라인 바로 플레이 (GitHub Pages)
👉 **https://lucky7lee.github.io/daepogame/**

*(싱글 플레이 및 온라인 2~4인 멀티 대기실 모두 위 링크 및 안드로이드 APK에서 별도 서버 설치 없이 바로 작동합니다!)*

## 📱 안드로이드 APK 설치 & Google Play 스토어 등록 (GitHub Actions 자동 빌드)
이 저장소에 코드가 푸시되면 [`.github/workflows/build-android.yml`](.github/workflows/build-android.yml) 워크플로우가 자동으로 실행되어 다음 파일들을 생성합니다:
- **`TankClash-release.apk`**: 안드로이드 스마트폰/스마트탭에 바로 설치 가능한 패키지 (게임 에셋 내장으로 오프라인 싱글 플레이 지원 + GitHub 서버리스 2~4인 실시간 멀티플레이 연동)
- **`TankClash-playstore.aab`**: Google Play Console 정식 등록용 Android App Bundle (`targetSdk 35`, 정식 키스토어 서명 완료)
- **`playstore-icon-512.png`**: Google Play 스토어 등록용 512×512 앱 아이콘
- **`playstore-feature-graphic.png`**: Google Play 스토어 등록용 1024×500 그래픽 이미지
- **개인정보처리방침 URL**: `https://lucky7lee.github.io/daepogame/privacy.html` ([privacy.html](privacy.html))

### 📥 APK / AAB 다운로드 위치
1. GitHub 저장소 우측의 **Releases (`latest-apk`)** 페이지에서 `TankClash-release.apk` 또는 `TankClash-playstore.aab` 바로 다운로드
2. 또는 상단 **Actions** 탭 → **Build Android APK & Google Play AAB** 최신 워크플로우 클릭 → 하단 **Artifacts (`TankClash-Android-...`)** 다운로드

## ✨ 주요 특징
- **포물선 탄도 수학 & 바람 시스템**: 각도·파워·중력·풍속이 반영된 정밀 탄도 물리 엔진
- **실시간 지형 파괴**: 포탄 폭발 시 크레이터 생성 및 중력 낙하·수장 처리
- **영점 조절 AI**: 초기 거리 계산 후 난수 탐색 사격 → 턴마다 탄착 오차를 줄여 영점을 맞추는 AI
- **싱글 플레이 (1~4인)**: AI 1~3명 추가 대전(2~4인용), 1인 영점 연습, 로컬 교대(2~4인) 지원
- **온라인 멀티 플레이 (2~4인)**: 대기실 방 생성 후 참여 유저 수(2명/3명/4명)에 맞춘 실시간 멀티플레이 지원 (APK 유저 ↔ 웹 유저 크로스플레이 완벽 호환)
- **스마트폰 & 스마트탭 & PC 최적화**: 세로 높이 고정 + 포탄 추적 및 수동 드래그 좌우 스크롤 + 미니맵 레이더 + 안드로이드 뒤로가기 버튼 완벽 대응

## 🖥️ 로컬 서버 실행 방법
```bash
node server.js
```
기본 접속 주소: `http://localhost:3020`
