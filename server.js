import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBareServer } from '@tomphttp/bare-server-node';
import { server as wisp } from '@mercuryworkshop/wisp-js/server';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = (p) => join(__dirname, 'node_modules', p);

const app = express();
app.use(compression());

// Allow the Xenon portal (or anything) to link into this proxy.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// public/ is mounted FIRST so our own uv.config.js overrides the package default.
app.use(express.static(join(__dirname, 'public')));
app.use('/uv/',      express.static(pkg('@titaniumnetwork-dev/ultraviolet/dist')));
app.use('/scram/',   express.static(pkg('@mercuryworkshop/scramjet/dist')));
app.use('/baremux/', express.static(pkg('@mercuryworkshop/bare-mux/dist')));
app.use('/epoxy/',   express.static(pkg('@mercuryworkshop/epoxy-transport/dist')));
app.use('/libcurl/', express.static(pkg('@mercuryworkshop/libcurl-transport/dist')));
app.use('/baremod/', express.static(pkg('@mercuryworkshop/bare-as-module3/dist')));

app.get('/healthz', (req, res) => res.json({ ok: true, engine: 'ultraviolet' }));

const bare = createBareServer('/bare/');
const server = createServer();

server.on('request', (req, res) => {
  if (bare.shouldRoute(req)) bare.routeRequest(req, res);
  else app(req, res);
});

server.on('upgrade', (req, socket, head) => {
  if (bare.shouldRoute(req)) return bare.routeUpgrade(req, socket, head);
  if (req.url.startsWith('/wisp/')) return wisp.routeRequest(req, socket, head);
  socket.end();
});

const port = process.env.PORT || 8080;
server.listen(port, () => console.log('xenon-proxy listening on ' + port));
