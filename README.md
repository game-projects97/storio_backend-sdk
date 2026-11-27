# Backend SDK

Backend SDK는 JavaScript·TypeScript 게임에서 백엔드 API를 호출하는 클라이언트다.

## 설치

게임의 `package.json`이 있는 폴더에서 실행한다. [GitHub Release v0.3.0](https://github.com/game-projects97/storio_backend-sdk/releases/tag/v0.3.0)

```sh
npm install --save-exact https://github.com/game-projects97/storio_backend-sdk/releases/download/v0.3.0/backend-sdk-0.3.0.tgz
```

```ts
import { Backend, BackendError } from "backend-sdk";
```

기존 프로젝트를 0.3.0으로 올릴 때 의존성 이름을 `@storio/platform-sdk`에서 `backend-sdk`로 바꾼다. 코드에서 `PlatformClient`와 `PlatformError`를 각각 `Backend`와 `BackendError`로 바꾼다.

## 빌드와 설치 검사

SDK 저장소 루트에서 Node.js 24로 실행한다. 배포물은 지정한 폴더에 만든다.

```sh
npm ci
release_dir="$(mktemp -d)"
npm run pack:artifact -- "$release_dir"
npm run verify -- "$release_dir/backend-sdk-0.3.0.tgz"
```

`npm run verify`에 배포물 경로를 생략하면 임시 폴더에서 패키지를 생성하고 설치한다.
