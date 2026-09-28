# Development environment setup

Windows-first, because that is where the demo laptop is. macOS and Linux work
too; the PowerShell scripts are platform-agnostic.

> If you received this as a **zip of a working folder** rather than a git clone,
> read §0 first. Two files contain absolute paths from the original machine and
> will break your build.

---

## 0. Getting the code

**Preferred — clone.** Nothing machine-specific comes along, because the paths are
gitignored.

```powershell
git clone https://github.com/Sanjaykts/android-break.git
cd android-break
```

**If you were given a zip**, extract it, then delete these two files before
building. Both contain absolute paths from the machine that made them:

```powershell
Remove-Item agent\local.properties -ErrorAction SilentlyContinue
Remove-Item agent\keystore.properties -ErrorAction SilentlyContinue
```

`local.properties` is regenerated on the first build. `keystore.properties` is
only needed to sign locally, and you do not need to — CI signs the release APK
from the `KEYSTORE_BASE64` secret. Without it, a local `assembleRelease` produces
an unsigned APK, which is fine for development.

The zip will also contain `agent\keystore.jks`. You do not need it (see above).
**If you do keep it, treat the zip as a secret** — see `HANDOVER.md` §1.

---

## 1. Toolchain

| Tool | Version | Why |
|---|---|---|
| **JDK** | 17 or 21 | Gradle 8.7 + AGP 8.5.2. 21 is fine. |
| **Android SDK** | platform 34, build-tools 34.0.0 | `compileSdk`/`targetSdk` 34 |
| **Node.js** | 22 or newer | Cloudflare Wrangler 4, and Node's global `WebSocket` is used by the test tools |
| **Chrome** | current | The console, the recorder, and all browser tests |
| **PowerShell** | 5.1 (built in) or 7 | The `.cmd` scripts. The `.cmd` wrappers bypass execution policy. |

### JDK

```powershell
winget install EclipseAdoptium.Temurin.17.JDK
```

Verify: `java -version`. If it reports 21, that is also fine.

### Android SDK

Install Android Studio, or the command-line tools alone:

```powershell
winget install Google.AndroidStudio
```

Then in Android Studio: **Settings → Languages & Frameworks → Android SDK**, and
tick:

- Android SDK Platform 34
- Android SDK Build-Tools 34.0.0
- Android SDK Platform-Tools

Point the environment at it so Gradle finds it without a `local.properties`:

```powershell
[Environment]::SetEnvironmentVariable("ANDROID_HOME", "$env:LOCALAPPDATA\Android\Sdk", "User")
```

Reopen your shell afterwards. `check-all.cmd` also probes
`%LOCALAPPDATA%\Android\Sdk` automatically.

### Node

```powershell
winget install OpenJS.NodeJS.LTS
```

Verify: `node -v` should be 22 or higher. The relay test tools use Node's global
`WebSocket`; on older Node they will fail with a confusing "WebSocket is not
defined".

---

## 2. First build

```powershell
.\check-all.cmd -Quick
```

That does everything: Android build, lint, unit tests, then the four relay suites
against a real local Worker. Expect three to four minutes the first time, two
afterwards.

If the Android part reports `SKIP`, the SDK was not found — go back to §1 and
check `ANDROID_HOME`.

### Relay dependencies

`check-all.cmd` installs them automatically. To do it by hand:

```powershell
cd relay
npm install
```

The first install is large (Puppeteer downloads a Chromium). It is only needed for
the browser test suites; the relay itself deploys without it.

### Local relay secrets

`relay\.dev.vars` is gitignored, so create it. Use the **same** `AGENT_TOKEN` that
CI built the APK with, or the phone will be refused:

```powershell
cd relay
"AGENT_TOKEN=`"<value>`"" | Out-File .dev.vars -Encoding utf8
"CONSOLE_TOKEN=`"<value>`"" | Out-File .dev.vars -Append -Encoding utf8
```

Then:

```powershell
npm run dev      # http://127.0.0.1:8787
```

---

## 3. Everyday commands

From the repo root:

```powershell
.\check-all.cmd             # everything, ~3 min
.\check-all.cmd -Quick      # skip the 30s load test
.\demo-preflight.cmd        # red/green pre-demo checks
.\demo-start.cmd            # health check, open console fullscreen
.\demo-freeze.cmd           # the final gate before the demo
```

From `relay/`:

```powershell
npm run dev              # local Worker
npm run deploy           # deploy
npm run typecheck        # tsc
npm run e2e              # 27 control-plane checks
npm run smoke            # 32 checks in real headless Chrome
npm run record           # 21 recording / presenter-camera checks
npm run loadtest         # frame-relay throughput
npm run rehearse         # all six demo beats, on a timer
npm run soak             # 30-minute stability, against a real device
```

From `agent/`:

```powershell
.\gradlew.bat assembleRelease     # signed if keystore.properties exists
.\gradlew.bat assembleDebug       # always works, no keystore needed
.\gradlew.bat installDebug         # only if you ever attach a device by USB
```

There is no `installDebug` step you need. The no-USB rule means the app is
installed by the phone's owner from a browser link, not from your laptop.

---

## 4. If a build fails

Go to `docs/TROUBLESHOOTING.md`. The four most common, in order:

1. `SDK location not found` — `ANDROID_HOME` unset, or `local.properties` holds a
   stale macOS path.
2. `Unsupported class file major version` — wrong JDK. Use 17 or 21.
3. `npm error enoent` in the relay suites — `npm install` was not run in `relay/`.
4. `WebSocket is not defined` — Node older than 22.

---

## 5. macOS and Linux

Everything works. Use the `.sh` scripts:

```bash
./check-all.sh
./demo-preflight.sh
./demo-start.sh
./demo-freeze.sh
```

Or the PowerShell ones, which are platform-agnostic — `check-all.ps1` picks
`gradlew` vs `gradlew.bat` and `npx` vs `npx.cmd` automatically.

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export ANDROID_HOME=$HOME/android-sdk
cd relay && npm install && npm run dev
```
