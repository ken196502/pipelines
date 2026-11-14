import { readFile } from 'node:fs/promises';
import type { ZodType } from 'zod';
import { ConfigError } from '../errors.js';

interface JsonLocation {
  line?: number;
  column?: number;
  position?: number;
}

class JsonOffset extends Error {
  constructor(readonly offset: number) {
    super(`JSON syntax error at ${offset}`);
  }
}

/**
 * Minimal strict JSON scanner used only to find the offset of a syntax error.
 * Node's JSON.parse message includes a position for most errors but not all
 * (for example "Unexpected token '}' ... is not valid JSON").
 */
class JsonScanner {
  #pos = 0;
  constructor(private readonly text: string) {}

  scan(): void {
    this.#value();
    this.#whitespace();
    if (this.#pos !== this.text.length) this.#fail();
  }

  #fail(): never {
    throw new JsonOffset(this.#pos);
  }

  #whitespace(): void {
    while (this.#pos < this.text.length && ' \t\n\r'.includes(this.text[this.#pos] as string)) {
      this.#pos += 1;
    }
  }

  #value(): void {
    this.#whitespace();
    const char = this.text[this.#pos];
    if (char === undefined) this.#fail();
    if (char === '{') return this.#object();
    if (char === '[') return this.#array();
    if (char === '"') return this.#string();
    if (char === '-' || (char >= '0' && char <= '9')) return this.#number();
    for (const literal of ['true', 'false', 'null']) {
      if (this.text.startsWith(literal, this.#pos)) {
        this.#pos += literal.length;
        return;
      }
    }
    this.#fail();
  }

  #object(): void {
    this.#pos += 1;
    this.#whitespace();
    if (this.text[this.#pos] === '}') {
      this.#pos += 1;
      return;
    }
    for (;;) {
      this.#whitespace();
      if (this.text[this.#pos] !== '"') this.#fail();
      this.#string();
      this.#whitespace();
      if (this.text[this.#pos] !== ':') this.#fail();
      this.#pos += 1;
      this.#value();
      this.#whitespace();
      if (this.text[this.#pos] === ',') {
        this.#pos += 1;
        continue;
      }
      if (this.text[this.#pos] === '}') {
        this.#pos += 1;
        return;
      }
      this.#fail();
    }
  }

  #array(): void {
    this.#pos += 1;
    this.#whitespace();
    if (this.text[this.#pos] === ']') {
      this.#pos += 1;
      return;
    }
    for (;;) {
      this.#value();
      this.#whitespace();
      if (this.text[this.#pos] === ',') {
        this.#pos += 1;
        continue;
      }
      if (this.text[this.#pos] === ']') {
        this.#pos += 1;
        return;
      }
      this.#fail();
    }
  }

  #string(): void {
    this.#pos += 1;
    while (this.#pos < this.text.length) {
      const char = this.text[this.#pos];
      if (char === '"') {
        this.#pos += 1;
        return;
      }
      if (char === '\\') {
        this.#pos += 2;
        continue;
      }
      if (char !== undefined && char.charCodeAt(0) < 0x20) this.#fail();
      this.#pos += 1;
    }
    this.#fail();
  }

  #number(): void {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.#pos));
    if (!match) this.#fail();
    this.#pos += (match as RegExpExecArray)[0].length;
  }
}

function locateByOffset(raw: string, position: number): JsonLocation {
  const before = raw.slice(0, position);
  const line = before.split('\n').length;
  const column = position - before.lastIndexOf('\n');
  return { line, column, position };
}

function jsonErrorLocation(raw: string, message: string): JsonLocation {
  const lineColumn = /line (\d+) column (\d+)/.exec(message);
  if (lineColumn) {
    return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
  }
  const positionMatch = /position (\d+)/.exec(message);
  if (positionMatch) {
    return locateByOffset(raw, Number(positionMatch[1]));
  }
  try {
    new JsonScanner(raw).scan();
  } catch (err) {
    if (err instanceof JsonOffset) return locateByOffset(raw, err.offset);
    throw err;
  }
  return {};
}

/**
 * Reads and validates a JSON config file. A missing file, unreadable file,
 * malformed JSON or schema violation is a ConfigError; nothing is defaulted.
 */
export async function readJsonConfig<T>(file: string, schema: ZodType<T>): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError('CONFIG_NOT_FOUND', `Config file not found: ${file}`, { path: file }, { cause: err });
    }
    throw new ConfigError('CONFIG_READ_FAILED', `Cannot read config file ${file}.`, { path: file }, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const location = jsonErrorLocation(raw, message);
    const where = location.line !== undefined ? ` at line ${location.line}, column ${location.column}` : '';
    throw new ConfigError(
      'CONFIG_PARSE',
      `Invalid JSON in ${file}${where}: ${message}`,
      { path: file, ...location },
      { cause: err },
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }));
    const summary = issues.map((issue) => `${issue.path || '<root>'}: ${issue.message}`).join('; ');
    throw new ConfigError('CONFIG_INVALID', `Invalid config ${file}: ${summary}`, { path: file, issues });
  }
  return result.data;
}

/** Reads a required environment variable. Empty values count as missing. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(
      'ENV_MISSING',
      `Environment variable ${name} is not set. Add it to .env (see .env.example).`,
      { name },
    );
  }
  return value;
}
