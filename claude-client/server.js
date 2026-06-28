'use strict';

const express = require('express');
const { askClaude } = require('./claude-client');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Logs each activity for log section

function log(level, event, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

// Request / response logging middleware
app.use((req, res, next) => {
  const startedAt = Date.now();

  log('info', 'request_received', {
    method: req.method,
    path: req.path,
    ip: req.ip,
  });

  res.on('finish', () => {
    log('info', 'request_completed', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - startedAt,
    });
  });

  next();
});

// --- Routes ---

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Query Claude
app.post('/query', async (req, res) => {
  const { prompt, allowedTools, resume } = req.body ?? {};

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    log('warn', 'bad_request', { reason: 'missing or invalid prompt' });
    return res.status(400).json({ error: 'prompt is required and must be a non-empty string' });
  }

  log('info', 'claude_query_start', {
    prompt_preview: prompt.slice(0, 120),
    allowedTools: allowedTools ?? null,
    resume: resume ?? null,
  });

  const queryStart = Date.now();

  try {
    const { result, sessionId, costUsd, messages } = await askClaude(prompt, {
      allowedTools,
      resume,
    });

    const duration = Date.now() - queryStart;

    log('info', 'claude_query_complete', {
      duration_ms: duration,
      message_count: messages.length,
      session_id: sessionId,
      cost_usd: costUsd,
    });

    res.json({ result, sessionId, costUsd, duration_ms: duration });
  } catch (err) {
    const duration = Date.now() - queryStart;
    log('error', 'claude_query_failed', {
      error: err.message,
      duration_ms: duration,
    });
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static('public'));

// 404 handler
app.use((req, res) => {
  log('warn', 'not_found', { method: req.method, path: req.path });
  res.status(404).json({ error: 'Not found' });
});

// --- Start ---

app.listen(PORT, () => {
  log('info', 'server_started', { port: PORT });
  log('info', 'endpoints', {
    health: `GET  http://localhost:${PORT}/health`,
    query:  `POST http://localhost:${PORT}/query  { "prompt": "..." }`,
  });
});

module.exports = app;
