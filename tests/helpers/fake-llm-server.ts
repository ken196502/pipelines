import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export type FakeHandler = (req: FakeRequest, res: ServerResponse, index: number) => void | Promise<void>;

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function chatCompletion(content: string, finishReason = 'stop'): Record<string, unknown> {
  return {
    model: 'fake-model',
    choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function defaultHandler(_req: FakeRequest, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(chatCompletion('hello from the fake')));
}

/**
 * OpenAI-compatible fake on 127.0.0.1:0. It records every request and lets the
 * test decide the reply per call. It never talks to the network.
 */
export class FakeLlmServer {
  readonly url: string;
  readonly requests: FakeRequest[] = [];
  handler: FakeHandler;
  readonly #server: Server;

  private constructor(server: Server, url: string, handler: FakeHandler) {
    this.#server = server;
    this.url = url;
    this.handler = handler;
  }

  static async start(handler?: FakeHandler): Promise<FakeLlmServer> {
    let instance: FakeLlmServer;
    const server = createServer(async (req, res) => {
      const raw = await readBody(req);
      let body: unknown = undefined;
      if (raw !== '') {
        try {
          body = JSON.parse(raw);
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `invalid request JSON: ${String(err)}` }));
          return;
        }
      }
      const record: FakeRequest = { method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers, body };
      instance.requests.push(record);
      try {
        await instance.handler(record, res, instance.requests.length - 1);
      } catch (err) {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `fake handler failed: ${String(err)}` }));
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    instance = new FakeLlmServer(server, `http://127.0.0.1:${address.port}`, handler ?? defaultHandler);
    return instance;
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
