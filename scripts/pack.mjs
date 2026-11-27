import {
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { artifactName, packSdk, sdkRoot } from "./artifact.mjs";

if (!process.argv[2]) {
  throw new Error("SDK 루트 밖의 산출물 폴더를 지정하세요.");
}
const destination = realpathSync(process.argv[2]);
const fromSdk = relative(realpathSync(sdkRoot), destination);
if (
  fromSdk !== ".." &&
  !fromSdk.startsWith(`..${sep}`) &&
  !isAbsolute(fromSdk)
) {
  throw new Error("SDK 루트 밖의 산출물 폴더를 지정하세요.");
}
const artifactPath = join(destination, artifactName);
if (existsSync(artifactPath)) {
  throw new Error(`배포물이 이미 있습니다. ${artifactPath}`);
}
const directory = mkdtempSync(join(tmpdir(), "backend-sdk-pack-"));
try {
  copyFileSync(packSdk(directory), artifactPath, constants.COPYFILE_EXCL);
  console.log(artifactPath);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
