# 둘이모아 보안 서버 배포 및 앱 설정

앱은 Firestore SDK를 직접 사용하지 않습니다. Firestore 규칙은 모든 클라이언트 요청을 거부하고, 인증된 Cloud Functions만 Admin SDK로 데이터를 다룹니다. 기존 `MONG-xxxx` 참여 코드는 제거했으며 기존 `artifacts/.../ledgers` 경로 데이터는 읽거나 옮기지 않습니다.

## 데이터 구조

- `users/{uid}`: Firebase UID, 연결된 ledger ID, 계정 상태와 표시용 별명
- `kakaoIdentityHashes/{sha256(kakaoUserId)}`: 카카오 ID 원문 대신 SHA-256 해시로 Firebase UID를 찾는 서버 전용 매핑
- `ledgers/{ledgerId}`: 방장 UID, 최대 2명의 `memberUids`, 가계부 데이터와 별명
- `ledgers/{ledgerId}/auditEvents/{eventId}`: 초대/수정/연결 해제 작업 이력
- `inviteTokens/{sha256(token)}`: 원문 토큰은 발급 응답 한 번만 반환하고 저장하지 않음. 24시간 뒤 만료, 수락 후 즉시 폐기
- `securityCounters/{keyHash}`: 인증/초대 시도 제한 카운터

## 인증과 권한 흐름

1. Android Kakao SDK로 로그인하고 카카오 Access Token을 인증 함수에 HTTPS로 전달합니다.
2. `exchangeKakao`가 Kakao `/v2/user/me`로 토큰을 확인합니다. 성공한 카카오 계정의 해시 매핑을 찾거나 새 Firebase 사용자와 빈 가계부를 트랜잭션으로 만듭니다. 원문 카카오 토큰은 기록하거나 저장하지 않습니다.
3. 함수가 Firebase Custom Token을 돌려주고, WebView는 Firebase Auth로 로그인합니다.
4. `ledgerApi`는 각 요청에서 인증 UID를 읽고 `users/{uid}.ledgerId`, ledger 상태, `memberUids`를 서버에서 확인합니다. 클라이언트가 제출한 ledger ID는 권한 판단에 사용하지 않습니다.
5. 초대 수락은 서버 트랜잭션에서 만료/사용 여부, 자기 초대 여부, 정원, 기존 가계부 소유자와 구성원을 다시 검증합니다. 본인만 있는 개인 가계부에 데이터가 있으면 앱이 삭제 경고를 띄우고 확인한 경우 기존 ledger 문서를 제거합니다. 다른 구성원이 있는 ledger는 교체를 거부합니다. 백업이나 데이터 이관은 하지 않습니다.
6. 연결 해제 시 방장만 기존 공유 ledger에 남고 다른 사람은 즉시 구성원에서 제거되며 새 빈 ledger를 받습니다. 다음 callable 요청부터 이전 ledger 조회는 거부됩니다.

## Firebase 배포 순서

1. `functions/.env`나 소스 코드에 Admin 키를 넣지 마세요. Cloud Functions의 기본 서비스 계정 권한을 사용합니다.
2. Firebase Console에서 Authentication을 켜고, Cloud Functions/Firestore가 `jero-a0ce0` 프로젝트에 활성화됐는지 확인합니다. Kakao 로그인 서버는 Access Token 검증에 Kakao API를 사용합니다.
3. 저장소 루트에서 `firebase deploy --only firestore:rules,functions`를 실행합니다. 이 단계가 완료되어야 기존 직접 Firestore 요청이 전면 차단됩니다. 배포는 이 작업에서 실행하지 않았습니다.
4. Firestore TTL 정책에서 `inviteTokens.expiresAt` 및 `securityCounters.expiresAt`를 설정할 수 있습니다. 예약 함수도 만료 문서를 정리하지만 TTL은 추가 정리 수단입니다.
5. Functions/App Check 모니터링을 확인한 후 `ledgerApi`의 `enforceAppCheck`를 켜세요. 현재는 Play Integrity 앱 등록값과 WebView용 App Check provider가 이 저장소에 없어 callable에 App Check를 강제하지 않습니다. Firebase Auth, 서버 구성원 검증 및 Firestore 전면 차단은 적용됩니다.

## Android Studio 설정

- 이 앱은 Android Kakao SDK를 사용하므로 **Native AppKey만 필요합니다**. JS 키와 REST API 키는 현재 앱에서 사용하지 않습니다. 특히 REST 키를 Android 코드나 Firebase 함수에 넣지 마세요.
- 제공받은 Native AppKey는 이미 `android/local.properties`에 저장되어 있고, Gradle은 그 파일에서 읽습니다. `local.properties`는 Git에서 제외되어 있어 GitHub에 올라가지 않습니다. 이 파일을 공유하거나 키를 화면 캡처에 노출하지 마세요.
- Kakao Developers에서 Android 앱 `com.doolimoa.app`을 등록하고, Android 플랫폼의 패키지명과 개발/배포 서명 키 해시를 설정합니다. 카카오 로그인 기능도 사용 설정하고, 공유 기능을 위해 Kakao 제품 링크에 `jbusinessero-ctrl.github.io` 도메인을 등록합니다.
- Firebase 프로젝트를 바꾸거나 Functions region을 바꾸면 WebView의 Firebase 설정, `getFunctions` region, `kakaoExchangeUrl` 기본값을 함께 변경합니다. 기존 project ID는 현재 저장소의 Firebase 웹 설정에서 확인한 `jero-a0ce0`을 사용합니다.
- 초대 URL은 `invite.html?token=...`이며 Android가 설치되어 있으면 앱 intent로 열립니다. 앱이 없으면 Play Store `referrer=invite=...`를 거쳐 설치 후 Install Referrer API가 토큰을 앱에 전달합니다. 24시간이 지난 토큰은 연결되지 않습니다.
- GitHub Pages에서 `invite.html`이 공개된 뒤 Kakao 제품 링크와 Android의 `https://jbusinessero-ctrl.github.io/doolimoa_app` 링크 설정을 확인하세요. 앱 링크 자동 검증을 사용하려면 도메인의 `/.well-known/assetlinks.json`에 실제 Play 서명 지문도 등록해야 합니다.

## 웹 브라우저 카카오 로그인 설정

- 웹 페이지는 Kakao JavaScript SDK로 로그인 인가 코드를 받고, `exchangeKakao` 서버 함수가 REST 키로 토큰을 교환한 뒤 Firebase Custom Token을 반환합니다. REST 키는 브라우저에 포함하지 않습니다.
- Kakao Developers의 웹 플랫폼에 `https://jbusinessero-ctrl.github.io` 도메인을 등록하고, 카카오 로그인 Redirect URI `https://jbusinessero-ctrl.github.io/doolimoa_app/`를 **JavaScript 키와 REST API 키 양쪽 설정에 모두** 등록해야 합니다. 프로토콜, 전체 경로, 끝의 `/`까지 정확히 같아야 합니다.
- Kakao REST API 키 설정에서 Client Secret이 활성화되어 있으면 인가 코드를 토큰으로 바꿀 때 Client Secret도 필요합니다. Kakao Developers에서 해당 REST API 키의 Client Secret 코드를 확인하세요.
- Firebase CLI로 `jero-a0ce0` 프로젝트에 로그인한 뒤 `firebase functions:secrets:set KAKAO_REST_KEY` 및 `firebase functions:secrets:set KAKAO_CLIENT_SECRET`를 각각 실행하고, 각 프롬프트에 해당 값을 입력하세요. 키와 Client Secret은 저장소 파일이나 채팅에 넣지 않습니다.
- 그 다음 저장소 루트에서 `firebase deploy --only functions:exchangeKakao`로 함수를 배포하고, `index.html`을 GitHub Pages에 올리세요. 서버 함수와 웹 페이지가 모두 최신이어야 브라우저 로그인이 완료됩니다.

## Firebase Custom Token 서명 권한

- Kakao 인증 이후 Firebase Custom Token을 만들려면 Cloud Functions 실행 서비스 계정에 `iam.serviceAccounts.signBlob` 권한이 필요합니다. 이 프로젝트의 Gen 2 함수 로그에서 실행 계정은 `634637692017-compute@developer.gserviceaccount.com`으로 확인됐습니다.
- Google Cloud Console에서 `jero-a0ce0` 프로젝트의 **IAM 및 관리자 → 서비스 계정**으로 이동하고 위 계정의 권한을 엽니다. 해당 서비스 계정에 `Service Account Token Creator` (`roles/iam.serviceAccountTokenCreator`) 역할을 부여합니다. 가능한 경우 프로젝트 전체가 아니라 해당 서비스 계정 리소스에만 권한을 부여하세요.
- 권한 전파에 잠시 시간이 걸릴 수 있습니다. 적용 후에는 Android 빌드나 함수 재배포 없이 웹 로그인을 다시 시도할 수 있습니다.

## 운영 메모

- `ledgerApi`는 기존 단일 문서 화면을 유지할 수 있도록 가계부 본문을 서버에서만 읽고 쓰는 callable API로 제공합니다. member UID, owner, 멤버 목록, 상태, revision 같은 권한 필드는 클라이언트 쓰기 입력에서 제거되어 있고, revision 비교가 동시 저장 덮어쓰기를 막습니다.
- 공유 ledger 데이터는 두 구성원이 편집할 수 있습니다. 감사 이벤트는 작업자 UID와 시각을 기록하며, 거래/자산 단위 CRUD와 변경 전후 감사 세부정보는 후속 개선 범위입니다.
- WebView 화면은 변경 후 `android/app/src/main/assets/`에 동일한 `index.html`과 `invite.html`을 반영해야 합니다.
