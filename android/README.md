# 둘이모아 Android 앱

이 Android 프로젝트는 저장소 안의 `app/src/main/assets/index.html`을 전체 화면 WebView로 표시합니다. 앱 ID는 웹 매니페스트에 맞춰 `com.doolimoa.app`으로 설정했습니다.

웹 화면을 수정할 때는 프로젝트 루트의 `index.html`, `manifest.json`, `sw.js`, 아이콘을 수정한 뒤 Android의 `app/src/main/assets/`에도 같은 파일을 복사해 주세요.

## APK 빌드

1. Android Studio에서 이 `android` 폴더를 엽니다.
2. Gradle 동기화가 끝나면 **Build > Build APK(s)** 를 선택합니다.
3. APK 위치: `app/build/outputs/apk/debug/app-debug.apk`

명령줄에서는 Android SDK와 JDK 17 이상을 설치한 뒤 이 폴더에서 `./gradlew assembleDebug`를 실행합니다. 첫 실행에는 Android Gradle Plugin 및 SDK 플랫폼 다운로드가 필요합니다.

배포용 APK/AAB는 Android Studio의 **Build > Generate Signed Bundle / APK**에서 별도의 서명 키로 생성하세요.
