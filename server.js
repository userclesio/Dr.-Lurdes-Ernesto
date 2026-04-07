const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const DEFAULT_PORT = Number(process.env.PORT || 3000);
const MAX_PORT_TRIES = 20;
const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, '.env.local');

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function loadLocalEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    return {};
  }

  const text = fs.readFileSync(ENV_FILE, 'utf8');
  const env = {};

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

function getOpenAiApiKey() {
  const localEnv = loadLocalEnv();
  return (process.env.OPENAI_API_KEY || localEnv.OPENAI_API_KEY || '').trim();
}

function getStaticPath(urlPathname) {
  const decoded = decodeURIComponent(urlPathname.split('?')[0]);
  const requested = decoded === '/' ? '/area_membros.html' : decoded;
  const normalized = path.normalize(requested).replace(/^(\.\.[/\\])+/, '');
  return path.join(ROOT, normalized);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handleChat(req, res) {
  try {
    const body = await readJsonBody(req);
    const apiKey = getOpenAiApiKey();
    const model = body.model || 'gpt-4o-mini';
    const systemPrompt = body.systemPrompt || '';
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const maxTokens = Number(body.maxTokens || 600);
    const temperature = typeof body.temperature === 'number' ? body.temperature : 0.75;

    if (!apiKey) {
      sendJson(res, 400, { error: { message: 'A API key da OpenAI não foi encontrada no servidor.' } });
      return;
    }

    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        max_tokens: maxTokens,
        temperature,
      }),
    });

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      sendJson(res, upstream.status, {
        error: {
          message: data.error?.message || 'Falha ao comunicar com a OpenAI.',
        },
      });
      return;
    }

    const reply = data.choices?.[0]?.message?.content;
    if (!reply) {
      sendJson(res, 502, { error: { message: 'A OpenAI não devolveu uma resposta válida.' } });
      return;
    }

    sendJson(res, 200, { reply });
  } catch (error) {
    const message = error instanceof SyntaxError
      ? 'O pedido recebido pelo servidor não estava em JSON válido.'
      : error.message || 'Erro inesperado no servidor local.';

    sendJson(res, 500, { error: { message } });
  }
}

function handleStatic(req, res) {
  const filePath = getStaticPath(req.url || '/');
  if (!filePath.startsWith(ROOT)) {
    sendJson(res, 403, { error: { message: 'Acesso negado.' } });
    return;
  }

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      sendJson(res, 404, { error: { message: 'Ficheiro não encontrado.' } });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    fs.createReadStream(filePath).pipe(res);
  });
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/chat') {
      handleChat(req, res);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      handleStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: { message: 'Método não permitido.' } });
  });
}

function startServer(port, attemptsLeft) {
  const server = createServer();

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
      const nextPort = port + 1;
      console.log(`Porta ${port} ocupada. A tentar ${nextPort}...`);
      startServer(nextPort, attemptsLeft - 1);
      return;
    }

    throw error;
  });

  server.listen(port, HOST, () => {
    console.log(`Servidor activo em http://${HOST}:${port}/area_membros.html`);
  });
}

if (process.env.NO_LISTEN !== '1') {
  startServer(DEFAULT_PORT, MAX_PORT_TRIES);
}

module.exports = { createServer };
