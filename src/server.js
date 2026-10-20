import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as core from './core.js';
import * as schemas from './schemas.js';
import { buildMcpServer } from './mcp.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));
const h = (fn) => async (req, res) => { try { res.type('json').send(core.toJson(await fn(req))); } catch (e) { res.status(400).json({ error: String(e.message || e) }); } };

app.get('/api/datasets', h(() => core.listDatasets()));
app.get('/api/schemas', h(() => schemas.listSchemas()));
app.get('/api/schemas/:name', h((r) => schemas.getSchema(r.params.name)));
app.post('/api/schemas', h((r) => schemas.saveSchema(r.body)));
app.get('/api/hf/splits', h((r) => core.hfSplits(r.query.dataset)));
app.get('/api/targets', h(() => core.listTargets()));
app.post('/api/run', h((r) => core.runPipeline(r.body)));
app.post('/api/import', h((r) => { const { url, ...o } = r.body; return core.importDataset(url, o); }));
app.get('/api/datasets/:id/preview', h((r) => core.preview(r.params.id, r.query.n, r.query.where)));
app.post('/api/datasets/:id/metadata', h((r) => { const { metadata, ...o } = r.body; return core.setMetadata(r.params.id, metadata, o); }));
app.post('/api/downloads/cleanup', h((r) => core.cleanupDownloads(r.body?.dataset_id)));
app.post('/api/datasets/:id/convert', h((r) => core.convertAndWrite(r.params.id, r.body)));

// MCP over streamable HTTP (stateless: fresh server+transport per request; dataset state is shared in-process)
app.post('/mcp', async (req, res) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.all('/mcp', (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));

const port = +process.env.PORT || 3000;
app.listen(port, () => console.log(`Sieve DatasetConverter: http://localhost:${port}  (MCP: /mcp)`));
