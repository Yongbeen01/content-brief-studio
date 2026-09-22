import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, HOME } from '../config.js';

/**
 * Claude CLI 를 LLM 으로 쓴다. 인증은 각자 PC 의 구독 로그인(브라우저)이고 API 키는 쓰지 않는다.
 *
 * claude-crew(src/tools.js · runner.js)에서 실제로 부딪혀 고친 규칙을 그대로 옮겼다.
 *  1. PATH 에 기대지 않고 claude 를 직접 찾아 **절대 경로**로 부른다. 바탕화면 아이콘으로 켜면
 *     설치 스크립트가 고쳐 둔 PATH 가 없다.
 *  2. 경로는 **슬래시**로 넘긴다. 백슬래시는 argv 에서 먹히고 cwd 기준으로 다시 풀린다.
 *  3. argv 에 **줄바꿈 금지**. 시스템 프롬프트는 파일로, 사용자 프롬프트는 stdin 으로.
 *  4. 과금 경로로 새지 않게 API 키류 환경변수를 지운다. 로그인 확인과 실제 호출이 같은 환경을 봐야
 *     "로그인됐다는데 호출은 실패" 가 안 생긴다.
 */

const isWin = process.platform === 'win32';
const exts = (p) => (isWin ? [`${p}.exe`, `${p}.cmd`, `${p}.bat`, p] : [p]);

function candidates() {
  return [
    path.join(HOME, '.local', 'bin'),
    path.join(HOME, 'AppData', 'Local', 'Programs', 'claude'),
    path.join(HOME, 'AppData', 'Roaming', 'npm'),
    path.join(HOME, '.bun', 'bin'),
    '/usr/local/bin',
  ];
}

function onPath(name) {
  try {
    const out = execFileSync(isWin ? 'where' : 'which', [name], {
      windowsHide: true, timeout: 5000, encoding: 'utf8',
    });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first && fs.existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

let cachedBin = null;

/** claude 의 절대 경로. 못 찾으면 'claude' 를 그대로 돌려준다 — 그게 곧 "미설치" 표시다. */
export function claudeBin() {
  if (cachedBin && (cachedBin === 'claude' ? false : fs.existsSync(cachedBin))) return cachedBin;
  let found = process.env.CBS_CLAUDE_BIN || process.env.CLAUDE_BIN || onPath('claude');
  if (!found) {
    outer: for (const dir of candidates()) {
      for (const file of exts('claude')) {
        const full = path.join(dir, file);
        try {
          if (fs.existsSync(full)) { found = full; break outer; }
        } catch { /* 다음 자리 */ }
      }
    }
  }
  cachedBin = found || 'claude';
  if (cachedBin !== 'claude') {
    // 찾은 폴더를 PATH 앞에 붙인다 — claude 가 자기 하위 도구를 부를 때도 같은 길을 쓰게.
    const dir = path.dirname(cachedBin);
    const sep = isWin ? ';' : ':';
    const parts = String(process.env.PATH ?? '').split(sep);
    if (!parts.some((p) => p.toLowerCase() === dir.toLowerCase())) {
      process.env.PATH = `${dir}${sep}${process.env.PATH ?? ''}`;
    }
  }
  return cachedBin;
}

export const claudeFound = () => claudeBin() !== 'claude';

/**
 * npm 으로 깐 PC 에서는 claude 가 `.cmd` 껍데기라 직접 실행할 수 없다(EINVAL 을 동기로 던진다).
 * 그럴 때만 cmd.exe 에 맡긴다. shell:true 로 붙이지 않는 이유는 인자를 이어 붙여서 공백이 있는
 * 경로가 쪼개지기 때문이다.
 */
export function claudeArgv(args) {
  const p = claudeBin();
  return /\.(cmd|bat)$/i.test(p) ? { cmd: 'cmd.exe', args: ['/c', p, ...args] } : { cmd: p, args };
}

export function cliEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

export const toPosix = (p) => String(p).replace(/\\/g, '/');

/** claude 는 자식 프로세스를 또 띄우므로 트리째 끝낸다. */
export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (isWin && child.pid) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

// ── 로그인 상태 ─────────────────────────────────────────────────────────────

let auth = { loggedIn: null, email: '', plan: '', method: '', checkedAt: 0, error: '' };
let authInFlight = null;

/** 캐시된 값을 준다. 낡았으면 뒤에서 갱신만 건다 — CLI 호출이 1초쯤 걸려 매번 부르면 서버가 멈춘다. */
export function authStatus({ maxAgeMs = 60_000 } = {}) {
  if (Date.now() - auth.checkedAt > maxAgeMs) refreshAuth();
  return { ...auth, found: claudeFound() };
}

/** `claude auth status` 는 JSON 을 준다. 문장에서 낱말을 찾지 않는다. */
export function refreshAuth() {
  if (authInFlight) return authInFlight;
  authInFlight = new Promise((resolve) => {
    if (!claudeFound()) {
      auth = { loggedIn: false, email: '', plan: '', method: '', checkedAt: Date.now(), error: 'not_installed' };
      authInFlight = null;
      resolve({ ...auth, found: false });
      return;
    }
    const a = claudeArgv(['auth', 'status']);
    execFile(a.cmd, a.args, { windowsHide: true, timeout: 20_000, env: cliEnv() }, (err, stdout) => {
      authInFlight = null;
      let next = { loggedIn: false, email: '', plan: '', method: '', checkedAt: Date.now(), error: '' };
      try {
        const j = JSON.parse(String(stdout));
        next = {
          loggedIn: !!j.loggedIn,
          email: j.email ?? '',
          plan: j.subscriptionType ?? '',
          method: j.authMethod ?? '',
          checkedAt: Date.now(),
          error: '',
        };
      } catch {
        next.error = String(err?.message ?? 'auth status 를 읽지 못했습니다').slice(0, 160);
      }
      auth = next;
      resolve({ ...auth, found: true });
    });
  });
  return authInFlight;
}

const LOGIN_SCRIPT = path.join(DATA_DIR, 'auth-login.cmd');

/**
 * 로그인 창에서 돌 배치 파일. **ASCII 만** 쓴다 — 배치는 콘솔 코드페이지로 읽혀서
 * 한글 사용자 이름이 든 경로를 적으면 그 줄이 깨진다. 경로는 환경변수로 넘긴다.
 */
function writeLoginScript() {
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'title Claude Code - sign in',
    'echo.',
    'echo   Signing in to Claude Code (for Content Brief Studio).',
    'echo   Finish in the browser, then come back here.',
    'echo.',
    // npm 으로 깐 claude 는 .cmd 라서 call 없이 부르면 제어가 돌아오지 않고 pause 까지 못 온다.
    'call "%CBS_CLAUDE_BIN%" auth login --claudeai',
    'set CBS_RC=%ERRORLEVEL%',
    'echo.',
    'if "%CBS_RC%"=="0" echo   Done. You can close this window.',
    'if not "%CBS_RC%"=="0" echo   Sign-in did not finish. Exit code %CBS_RC%.',
    'echo.',
    'pause',
    '',
  ];
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOGIN_SCRIPT, lines.join('\r\n'), 'ascii');
}

/**
 * 보이는 창으로 로그인을 띄운다. 명령을 인자에 담지 않고 .cmd 파일 하나만 부른다 —
 * Node 가 인자 속 따옴표를 \" 로 바꾸는데 cmd.exe 는 백슬래시를 탈출문자로 안 쳐서,
 * 인자로 넘기면 창이 떴다가 그대로 닫힌다(claude-crew 에서 겪은 고장).
 */
export function authLogin() {
  const bin = claudeBin();
  if (bin === 'claude') {
    return { ok: false, error: 'Claude Code 를 찾지 못했습니다. 설치한 뒤 다시 시도해 주세요.' };
  }
  if (!isWin) {
    spawn(bin, ['auth', 'login', '--claudeai'], { detached: true, stdio: 'ignore', env: cliEnv() }).unref();
    return { ok: true, started: true };
  }
  try {
    writeLoginScript();
  } catch (e) {
    return { ok: false, error: `로그인 창을 준비하지 못했습니다 — ${String(e.message).slice(0, 120)}` };
  }
  const child = spawn('cmd.exe', ['/c', 'start', '""', '/wait', `"${LOGIN_SCRIPT}"`], {
    stdio: 'ignore',
    windowsHide: false,
    shell: false,
    windowsVerbatimArguments: true,
    env: { ...cliEnv(), CBS_CLAUDE_BIN: bin },
  });
  child.on('close', () => { refreshAuth(); });
  child.on('error', () => { /* 화면의 폴링이 사실을 말한다 */ });
  child.unref();
  return { ok: true, started: true };
}

export function authLogout() {
  return new Promise((resolve) => {
    const a = claudeArgv(['auth', 'logout']);
    execFile(a.cmd, a.args, { windowsHide: true, timeout: 30_000, env: cliEnv() }, async (err) => {
      const now = await refreshAuth();
      resolve(err && now.loggedIn
        ? { ok: false, error: String(err.message).slice(0, 160), auth: now }
        : { ok: true, auth: now });
    });
  });
}

// ── 한 번 호출 ──────────────────────────────────────────────────────────────

export class ClaudeError extends Error {
  /** @param {'not_installed'|'not_logged_in'|'rate_limited'|'timeout'|'cancelled'|'failed'|'bad_output'} kind */
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const LOGIN_HINT = /(invalid api key|please run \/login|not logged in|authenticat|oauth token|401)/i;
const LIMIT_HINT = /(usage limit|rate limit|limit reached|too many requests|429)/i;

function friendlyReset(info) {
  const at = Number(info?.resetsAt ?? info?.resets_at ?? 0);
  if (!at) return '';
  const d = new Date(at > 1e12 ? at : at * 1000);
  return `${d.getHours()}시 ${String(d.getMinutes()).padStart(2, '0')}분`;
}

/**
 * claude -p 를 한 번 돌린다.
 *
 * @param {object} o
 * @param {string} o.system      시스템 프롬프트(파일로 넘긴다)
 * @param {string} o.prompt      사용자 프롬프트(stdin)
 * @param {object} [o.schema]    JSON Schema — 있으면 --json-schema 로 검증된 structured_output 을 받는다
 * @param {string} o.model
 * @param {string[]} [o.tools]   빈 배열이면 도구를 전부 끈다. PDF 를 읽힐 때만 ['Read']
 * @param {string[]} [o.addDirs] Read 가 볼 수 있는 폴더
 * @param {string} o.workDir     cwd. 빈 작업 폴더를 준다 — 에이전트형 CLI 가 엉뚱한 곳을 훑지 않게
 * @param {number} [o.timeoutMs]
 * @param {(ev:object)=>void} [o.onEvent]  진행 신호 {type:'tool'|'progress'|'phase', ...}
 * @param {AbortSignal} [o.signal]
 */
export function runClaude({
  system, prompt, schema, model, tools = [], addDirs = [], workDir,
  timeoutMs = 5 * 60_000, onEvent = () => {}, signal,
}) {
  return new Promise((resolve, reject) => {
    if (!claudeFound()) {
      reject(new ClaudeError('not_installed', 'Claude Code 가 설치되어 있지 않습니다.'));
      return;
    }
    fs.mkdirSync(workDir, { recursive: true });
    const sysFile = path.join(workDir, 'system.md');
    fs.writeFileSync(sysFile, system, 'utf8');

    const args = [
      '-p',
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', model,
      '--system-prompt-file', toPosix(sysFile),
      '--strict-mcp-config',
      '--setting-sources', '',
      '--no-session-persistence',
      '--settings', JSON.stringify({ disableAllHooks: true }),
    ];
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    if (tools.length) args.push('--tools', tools.join(','), '--allowedTools', ...tools);
    else args.push('--tools', '');
    for (const d of addDirs) args.push('--add-dir', toPosix(d));

    const a = claudeArgv(args);
    let child;
    try {
      child = spawn(a.cmd, a.args, { cwd: workDir, env: cliEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new ClaudeError('not_installed', `Claude 를 실행하지 못했습니다 — ${e.message}`));
      return;
    }

    const started = Date.now();
    let buf = '';
    let stderr = '';
    let result = null;
    let rateInfo = null;
    let chars = 0;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };

    const timer = setTimeout(() => {
      killTree(child);
      finish(reject, new ClaudeError('timeout', `Claude 응답이 ${Math.round(timeoutMs / 60000)}분 안에 끝나지 않았습니다.`));
    }, timeoutMs);

    const onAbort = () => {
      killTree(child);
      finish(reject, new ClaudeError('cancelled', '취소했습니다.'));
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const onLine = (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      switch (ev.type) {
        case 'stream_event': {
          const e = ev.event;
          if (e?.type === 'content_block_start') {
            const kind = e.content_block?.type;
            if (kind === 'thinking') onEvent({ type: 'phase', phase: 'thinking' });
            else if (kind === 'text' || kind === 'tool_use') onEvent({ type: 'phase', phase: 'writing' });
          }
          const d = e?.delta;
          const piece = d?.type === 'text_delta' ? d.text : d?.type === 'input_json_delta' ? d.partial_json : '';
          if (piece) {
            chars += piece.length;
            onEvent({ type: 'progress', chars });
          }
          break;
        }
        case 'assistant':
          for (const block of ev.message?.content ?? []) {
            if (block.type === 'tool_use' && block.name !== 'StructuredOutput') {
              onEvent({ type: 'tool', name: block.name, input: block.input });
            }
          }
          break;
        case 'rate_limit_event':
          rateInfo = ev.rate_limit_info ?? ev;
          break;
        case 'result':
          result = ev;
          break;
        default:
          break;
      }
    };

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8000);
    });
    child.on('error', (e) => {
      finish(reject, new ClaudeError(e.code === 'ENOENT' ? 'not_installed' : 'failed', `Claude 실행 실패 — ${e.message}`));
    });
    child.on('close', (code) => {
      if (buf.trim()) onLine(buf.trim());
      const durationMs = Date.now() - started;
      if (!result) {
        const tail = stderr.trim().slice(-400);
        if (LOGIN_HINT.test(stderr)) {
          finish(reject, new ClaudeError('not_logged_in', 'Claude 에 로그인되어 있지 않습니다. 오른쪽 위 [Claude 로그인]을 눌러 주세요.'));
        } else {
          finish(reject, new ClaudeError('failed', `Claude 가 답 없이 끝났습니다 (코드 ${code}). ${tail}`));
        }
        return;
      }
      const text = String(result.result ?? '');
      if (result.is_error) {
        if (LOGIN_HINT.test(text)) {
          finish(reject, new ClaudeError('not_logged_in', 'Claude 에 로그인되어 있지 않습니다. 오른쪽 위 [Claude 로그인]을 눌러 주세요.'));
          return;
        }
        if (LIMIT_HINT.test(text) || rateInfo?.status === 'rejected') {
          const when = friendlyReset(rateInfo);
          finish(reject, new ClaudeError('rate_limited',
            `Claude 사용 한도에 걸렸습니다.${when ? ` ${when}에 풀립니다.` : ''}`, { resetsAt: rateInfo?.resetsAt }));
          return;
        }
        finish(reject, new ClaudeError('failed', `Claude 오류 — ${text.slice(0, 300) || result.subtype}`));
        return;
      }
      finish(resolve, {
        structured: result.structured_output ?? null,
        text,
        usage: result.usage ?? null,
        durationMs,
        subtype: result.subtype,
      });
    });

    child.stdin.on('error', () => { /* 프로세스가 먼저 끝나면 EPIPE — close 에서 처리 */ });
    child.stdin.end(prompt, 'utf8');
  });
}
