import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import { SqlSchema, SqlTable, SqlColumn, SqlRelation, generateSqlFromSchema } from './sqlParser';

/**
 * Return all non-internal IPv4 addresses sorted so real LAN IPs (192.168.x.x, 10.x.x.x)
 * come before virtual WSL/Docker/vEthernet adapters (172.16-31.x.x).
 */
export function getAllLocalIps(): { name: string; address: string; isVirtual: boolean }[] {
  const nets = os.networkInterfaces();
  const list: { name: string; address: string; isVirtual: boolean }[] = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        const isVirtual =
          /vethernet|wsl|docker|vbox|vmware|hyper-v|virbr/i.test(name) ||
          /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(net.address);
        list.push({ name, address: net.address, isVirtual });
      }
    }
  }

  list.sort((a, b) => Number(a.isVirtual) - Number(b.isVirtual));
  return list;
}

export interface CollabPeer {
  peerId: string;
  name: string;
  color: string;
  x: number;
  y: number;
  activeTable?: string;
  lastSeen: number;
}

export type CollabDelta =
  | { kind: 'fullSchema'; schema: SqlSchema }
  | { kind: 'moveTable'; tableName: string; x: number; y: number }
  | { kind: 'renameTable'; oldName: string; newName: string }
  | { kind: 'addTable'; table: SqlTable }
  | { kind: 'deleteTable'; tableName: string }
  | { kind: 'addColumn'; tableName: string; column: SqlColumn }
  | { kind: 'updateColumn'; tableName: string; oldColName: string; column: SqlColumn }
  | { kind: 'deleteColumn'; tableName: string; colName: string }
  | { kind: 'addRelation'; relation: SqlRelation }
  | { kind: 'deleteRelation'; relationId: string }
  | { kind: 'setDialect'; dialect: SqlSchema['dialect'] }
  | { kind: 'cursor'; peer: CollabPeer };

/**
 * Apply an atomic delta operation to a SqlSchema in place so 10+ users
 * can edit different tables/columns concurrently without overwriting each other.
 */
export function applyDeltaToSchema(schema: SqlSchema, delta: CollabDelta): boolean {
  switch (delta.kind) {
    case 'fullSchema':
      schema.dialect = delta.schema.dialect;
      schema.tables = delta.schema.tables;
      schema.relations = delta.schema.relations;
      return true;

    case 'setDialect':
      schema.dialect = delta.dialect;
      return true;

    case 'moveTable': {
      const t = schema.tables.find(tb => tb.name === delta.tableName);
      if (!t) return false;
      t.x = Math.round(delta.x);
      t.y = Math.round(delta.y);
      return true;
    }

    case 'renameTable': {
      const t = schema.tables.find(tb => tb.name === delta.oldName);
      if (!t) return false;
      t.name = delta.newName;
      for (const r of schema.relations) {
        if (r.fromTable === delta.oldName) r.fromTable = delta.newName;
        if (r.toTable === delta.oldName) r.toTable = delta.newName;
        r.id = `${r.fromTable}.${r.fromColumn}->${r.toTable}.${r.toColumn}`;
      }
      return true;
    }

    case 'addTable': {
      if (schema.tables.some(tb => tb.name === delta.table.name)) {
        return false;
      }
      schema.tables.push(delta.table);
      return true;
    }

    case 'deleteTable': {
      schema.tables = schema.tables.filter(tb => tb.name !== delta.tableName);
      schema.relations = schema.relations.filter(
        r => r.fromTable !== delta.tableName && r.toTable !== delta.tableName
      );
      return true;
    }

    case 'addColumn': {
      const t = schema.tables.find(tb => tb.name === delta.tableName);
      if (!t) return false;
      if (!t.columns.some(c => c.name === delta.column.name)) {
        t.columns.push(delta.column);
      }
      return true;
    }

    case 'updateColumn': {
      const t = schema.tables.find(tb => tb.name === delta.tableName);
      if (!t) return false;
      const col = t.columns.find(c => c.name === delta.oldColName);
      if (!col) return false;
      col.name = delta.column.name;
      col.type = delta.column.type;
      col.isPrimaryKey = delta.column.isPrimaryKey;
      col.isNullable = delta.column.isNullable;
      col.isUnique = delta.column.isUnique;
      if (delta.oldColName !== delta.column.name) {
        for (const r of schema.relations) {
          if (r.fromTable === delta.tableName && r.fromColumn === delta.oldColName) {
            r.fromColumn = delta.column.name;
          }
          if (r.toTable === delta.tableName && r.toColumn === delta.oldColName) {
            r.toColumn = delta.column.name;
          }
          r.id = `${r.fromTable}.${r.fromColumn}->${r.toTable}.${r.toColumn}`;
        }
      }
      return true;
    }

    case 'deleteColumn': {
      const t = schema.tables.find(tb => tb.name === delta.tableName);
      if (!t) return false;
      t.columns = t.columns.filter(c => c.name !== delta.colName);
      schema.relations = schema.relations.filter(
        r =>
          !(r.fromTable === delta.tableName && r.fromColumn === delta.colName) &&
          !(r.toTable === delta.tableName && r.toColumn === delta.colName)
      );
      return true;
    }

    case 'addRelation': {
      if (!schema.relations.some(r => r.id === delta.relation.id)) {
        schema.relations.push(delta.relation);
        return true;
      }
      return false;
    }

    case 'deleteRelation': {
      schema.relations = schema.relations.filter(r => r.id !== delta.relationId);
      return true;
    }

    case 'cursor':
      return false;
  }
}

export class SqlCollabRoomServer {
  private server: http.Server | null = null;
  private sseClients = new Set<http.ServerResponse>();
  private peers = new Map<string, CollabPeer>();
  private currentPort = 0;
  private revision = 1;
  private lastEditorPeerId = 'host';

  constructor(
    private getFileName: () => string,
    private getSchema: () => SqlSchema,
    private onRemoteDelta: (delta: CollabDelta, senderPeerId: string) => void,
    private getWebClientHtml: () => string
  ) {
    // Registrar al propio Host como participante activo en la sala
    this.peers.set('host', {
      peerId: 'host',
      name: 'Anfitrión (Host)',
      color: '#10b981',
      x: 0,
      y: 0,
      lastSeen: Date.now()
    });
  }

  public async start(port = 4580): Promise<number> {
    if (this.server) {
      return this.currentPort;
    }

    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

        // 1. Standalone Web UI for teammates joining via browser
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.getWebClientHtml());
          return;
        }

        // 2. Current state snapshot + fast revision polling fallback
        if (req.method === 'GET' && url.pathname === '/api/state') {
          const sinceRev = Number(url.searchParams.get('since') || '0');
          const peerId = url.searchParams.get('peerId') || '';
          const name = url.searchParams.get('name') || '';
          const color = url.searchParams.get('color') || '#38bdf8';

          if (peerId && name) {
            const existing = this.peers.get(peerId);
            this.peers.set(peerId, {
              peerId,
              name,
              color: existing?.color || color,
              x: existing?.x || 0,
              y: existing?.y || 0,
              activeTable: existing?.activeTable,
              lastSeen: Date.now()
            });
          }

          // Prune inactive peers (>15s without heartbeat)
          const now = Date.now();
          for (const [pid, p] of this.peers.entries()) {
            if (pid !== 'host' && now - p.lastSeen > 15000) {
              this.peers.delete(pid);
            }
          }

          const schema = this.getSchema();
          const unchanged = sinceRev > 0 && sinceRev === this.revision;

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              revision: this.revision,
              lastEditorPeerId: this.lastEditorPeerId,
              unchanged,
              fileName: this.getFileName(),
              schema: unchanged ? undefined : schema,
              sqlText: unchanged ? undefined : generateSqlFromSchema(schema),
              peers: Array.from(this.peers.values())
            })
          );
          return;
        }

        // 3. Real-time Server-Sent Events (SSE) stream
        if (req.method === 'GET' && url.pathname === '/api/events') {
          const peerId = url.searchParams.get('peerId') || '';
          const name = url.searchParams.get('name') || 'Usuario';
          const color = url.searchParams.get('color') || '#38bdf8';

          req.socket?.setNoDelay(true);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
          });
          res.flushHeaders?.();

          if (peerId) {
            this.peers.set(peerId, {
              peerId,
              name,
              color,
              x: 0,
              y: 0,
              lastSeen: Date.now()
            });
          }

          this.sseClients.add(res);

          res.write(
            `data: ${JSON.stringify({
              type: 'init',
              revision: this.revision,
              fileName: this.getFileName(),
              schema: this.getSchema(),
              peers: Array.from(this.peers.values())
            })}\n\n`
          );

          this.broadcastPeers();

          req.on('close', () => {
            this.sseClients.delete(res);
            if (peerId) {
              this.peers.delete(peerId);
              this.broadcastPeers();
            }
          });
          return;
        }

        // 4. Receive atomic delta or cursor movement from any peer
        if (req.method === 'POST' && url.pathname === '/api/op') {
          let body = '';
          req.on('data', chunk => {
            body += chunk;
          });
          req.on('end', () => {
            try {
              const payload = JSON.parse(body);
              const senderPeerId: string = payload.peerId || 'unknown';
              const delta: CollabDelta = payload.delta;

              if (delta.kind === 'cursor') {
                this.peers.set(delta.peer.peerId, {
                  ...delta.peer,
                  lastSeen: Date.now()
                });
                this.onRemoteDelta(delta, senderPeerId);
                this.broadcast({
                  type: 'delta',
                  revision: this.revision,
                  peerId: senderPeerId,
                  delta
                });
              } else {
                this.revision++;
                this.lastEditorPeerId = senderPeerId;
                this.onRemoteDelta(delta, senderPeerId);
                this.broadcast({
                  type: 'delta',
                  revision: this.revision,
                  peerId: senderPeerId,
                  delta
                });
              }

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, revision: this.revision }));
            } catch (err) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      });

      srv.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && port < 4600) {
          srv.close();
          this.start(port + 1).then(resolve, reject);
        } else {
          reject(err);
        }
      });

      srv.listen(port, '0.0.0.0', () => {
        this.server = srv;
        this.currentPort = port;
        resolve(port);
      });
    });
  }

  public broadcastDeltaFromHost(delta: CollabDelta): void {
    if (delta.kind === 'cursor') {
      this.peers.set('host', {
        ...delta.peer,
        peerId: 'host',
        lastSeen: Date.now()
      });
    } else {
      this.revision++;
      this.lastEditorPeerId = 'host';
    }
    this.broadcast({
      type: 'delta',
      revision: this.revision,
      peerId: 'host',
      delta
    });
  }

  public broadcastSchema(schema: SqlSchema, senderPeerId = 'host'): void {
    this.revision++;
    this.lastEditorPeerId = senderPeerId;
    this.broadcast({
      type: 'delta',
      revision: this.revision,
      peerId: senderPeerId,
      delta: { kind: 'fullSchema', schema }
    });
  }

  public getPeers(): CollabPeer[] {
    return Array.from(this.peers.values());
  }

  public broadcastPeers(): void {
    this.broadcast({
      type: 'peers',
      peers: Array.from(this.peers.values())
    });
  }

  private broadcast(message: unknown): void {
    const frame = `data: ${JSON.stringify(message)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(frame);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  public stop(): void {
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    this.sseClients.clear();
    this.peers.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

/**
 * Fetch initial state from a Host room URL so a Guest in VS Code can
 * automatically create and open the shared .sql / .dbml file!
 */
export function fetchRoomInitialState(
  roomUrl: string,
  sinceRev = 0,
  peerInfo?: { peerId: string; name: string; color: string }
): Promise<{
  revision: number;
  lastEditorPeerId?: string;
  unchanged?: boolean;
  fileName: string;
  schema: SqlSchema;
  sqlText: string;
  peers?: CollabPeer[];
}> {
  return new Promise((resolve, reject) => {
    const cleanUrl = roomUrl.trim().replace(/\/+$/, '');
    const params = new URLSearchParams();
    if (sinceRev > 0) params.set('since', String(sinceRev));
    if (peerInfo) {
      params.set('peerId', peerInfo.peerId);
      params.set('name', peerInfo.name);
      params.set('color', peerInfo.color);
    }
    const qs = params.toString();
    const target = `${cleanUrl}/api/state${qs ? `?${qs}` : ''}`;
    const client = target.startsWith('https://') ? https : http;
    client
      .get(target, res => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} al conectar con ${target}`));
          return;
        }
        let raw = '';
        res.on('data', chunk => (raw += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

/**
 * Node-side SSE + fast polling hybrid client so VS Code Guests receive
 * every edit in real time (<50ms via SSE, or <500ms via polling if a proxy buffers SSE).
 */
export class SqlCollabNodeClient {
  private req: http.ClientRequest | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastRevision = 0;
  private lastLocalSendTime = 0;
  public readonly peerId: string;
  public readonly color: string;

  constructor(
    public readonly roomUrl: string,
    public readonly userName: string,
    private onEvent: (msg: any) => void
  ) {
    this.peerId = 'vsc_' + Math.random().toString(36).slice(2, 9);
    const palette = ['#38bdf8', '#f59e0b', '#34d399', '#a78bfa', '#f472b6', '#fb7185'];
    this.color = palette[Math.floor(Math.random() * palette.length)];
  }

  public connect(): void {
    const clean = this.roomUrl.trim().replace(/\/+$/, '');
    const streamUrl = `${clean}/api/events?peerId=${encodeURIComponent(
      this.peerId
    )}&name=${encodeURIComponent(this.userName)}&color=${encodeURIComponent(this.color)}`;
    const client = streamUrl.startsWith('https://') ? https : http;

    this.req = client.get(streamUrl, res => {
      res.socket?.setNoDelay(true);
      let buffer = '';
      res.on('data', chunk => {
        buffer += chunk.toString();
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const frame of parts) {
          const line = frame.trim();
          if (line.startsWith('data:')) {
            try {
              const json = JSON.parse(line.slice(5).trim());
              if (typeof json.revision === 'number') {
                this.lastRevision = Math.max(this.lastRevision, json.revision);
              }
              this.onEvent(json);
            } catch {
              // ignore malformed frame
            }
          }
        }
      });
    });

    this.req.on('error', () => {
      // Fallback polling handles recovery automatically
    });

    // Hybrid 500ms sync poll guarantees real-time updates even if DevTunnels/proxies buffer SSE
    this.pollTimer = setInterval(async () => {
      if (Date.now() - this.lastLocalSendTime < 400) {
        return;
      }
      try {
        const state = await fetchRoomInitialState(this.roomUrl, this.lastRevision, {
          peerId: this.peerId,
          name: this.userName,
          color: this.color
        });
        if (state.peers) {
          this.onEvent({ type: 'peers', peers: state.peers });
        }
        if (!state.unchanged && state.schema && state.revision > this.lastRevision) {
          this.lastRevision = state.revision;
          if (state.lastEditorPeerId !== this.peerId) {
            this.onEvent({
              type: 'delta',
              revision: state.revision,
              peerId: state.lastEditorPeerId || 'host',
              delta: { kind: 'fullSchema', schema: state.schema }
            });
          }
        }
      } catch {
        // ignore transient network error
      }
    }, 500);
  }

  public sendDelta(delta: CollabDelta): void {
    if (delta.kind !== 'cursor') {
      this.lastLocalSendTime = Date.now();
    }
    const clean = this.roomUrl.trim().replace(/\/+$/, '');
    const u = new URL(`${clean}/api/op`);
    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;
    const payload = JSON.stringify({ peerId: this.peerId, delta });

    const r = client.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      res => {
        let body = '';
        res.on('data', c => (body += c));
        res.on('end', () => {
          try {
            const resp = JSON.parse(body);
            if (typeof resp.revision === 'number') {
              this.lastRevision = Math.max(this.lastRevision, resp.revision);
            }
          } catch {}
        });
      }
    );
    r.on('error', () => {});
    r.write(payload);
    r.end();
  }

  public disconnect(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.req) {
      this.req.destroy();
      this.req = null;
    }
  }
}
