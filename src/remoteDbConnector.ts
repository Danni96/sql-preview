import * as net from 'net';
import * as tls from 'tls';
import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { SqlSchema, SqlTable, SqlColumn, SqlRelation, parseSqlToSchema } from './sqlParser';

export interface RemoteDbConfig {
  engine: 'postgres' | 'mysql' | 'url';
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  dbSchema?: string; // ej. 'public' en Postgres
  tableFilter?: string; // ej. 'mnt_%' para no sobrecargar la PC si hay cientos de tablas
  ssl?: boolean;
}

/**
 * Descarga un archivo .sql o .dbml desde una URL remota (GitHub Raw, API, etc.)
 */
function fetchRemoteSqlUrl(url: string): Promise<SqlSchema> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https://') ? https : http;
    client
      .get(url, res => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} al descargar esquema de ${url}`));
          return;
        }
        let body = '';
        res.on('data', c => (body += c));
        res.on('end', () => {
          try {
            resolve(parseSqlToSchema(body));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

/**
 * Cliente ligero PostgreSQL Wire Protocol v3 en puro Node.js (net/tls/crypto)
 * Soporta autenticación Trust, Password, MD5 y SCRAM-SHA-256 sin sobrecargar la PC.
 */
async function queryPostgresWire(config: RemoteDbConfig, sqlQuery: string): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const port = config.port || 5432;
    const host = config.host || 'localhost';
    const user = config.user || 'postgres';
    const password = config.password || '';
    const database = config.database || 'postgres';

    let socket: net.Socket | tls.TLSSocket = net.connect(port, host);
    let buffer = Buffer.alloc(0);
    let rows: string[][] = [];
    let settled = false;

    // Estado SCRAM-SHA-256
    let clientNonce = '';
    let clientFirstMessageBare = '';

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      reject(err);
    };

    const done = (result: string[][]) => {
      if (settled) return;
      settled = true;
      try {
        socket.end();
      } catch {}
      resolve(result);
    };

    socket.setTimeout(12000, () => fail(new Error('Tiempo de espera agotado conectando a PostgreSQL remoto.')));
    socket.on('error', fail);

    function sendStartupMessage(sock: net.Socket | tls.TLSSocket) {
      const params = `user\0${user}\0database\0${database}\0client_encoding\0UTF8\0\0`;
      const bodyLen = 4 + 4 + Buffer.byteLength(params, 'utf8');
      const buf = Buffer.alloc(bodyLen);
      buf.writeInt32BE(bodyLen, 0);
      buf.writeInt32BE(196608, 4); // Protocol 3.0
      buf.write(params, 8, 'utf8');
      sock.write(buf);
    }

    function sendPacket(typeChar: string, payload: Buffer) {
      const header = Buffer.alloc(5);
      header.write(typeChar, 0, 1, 'ascii');
      header.writeInt32BE(payload.length + 4, 1);
      socket.write(Buffer.concat([header, payload]));
    }

    function sendQuery(q: string) {
      const qBuf = Buffer.from(q + '\0', 'utf8');
      sendPacket('Q', qBuf);
    }

    function attachListeners(sock: net.Socket | tls.TLSSocket) {
      sock.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 5) {
          const msgType = String.fromCharCode(buffer[0]);
          const msgLen = buffer.readInt32BE(1);
          if (buffer.length < 1 + msgLen) {
            break;
          }
          const payload = buffer.subarray(5, 1 + msgLen);
          buffer = buffer.subarray(1 + msgLen);

          if (msgType === 'R') {
            const authType = payload.readInt32BE(0);
            if (authType === 0) {
              // Auth OK
            } else if (authType === 3) {
              // Cleartext password
              sendPacket('p', Buffer.from(password + '\0', 'utf8'));
            } else if (authType === 5) {
              // MD5 password
              const salt = payload.subarray(4, 8);
              const inner = crypto.createHash('md5').update(password + user, 'utf8').digest('hex');
              const outer = crypto
                .createHash('md5')
                .update(Buffer.concat([Buffer.from(inner, 'ascii'), salt]))
                .digest('hex');
              sendPacket('p', Buffer.from('md5' + outer + '\0', 'utf8'));
            } else if (authType === 10) {
              // SASL (SCRAM-SHA-256)
              clientNonce = crypto.randomBytes(18).toString('base64');
              clientFirstMessageBare = `n=${user},r=${clientNonce}`;
              const clientFirstMessage = `n,,${clientFirstMessageBare}`;
              const mech = Buffer.from('SCRAM-SHA-256\0', 'utf8');
              const msgBuf = Buffer.from(clientFirstMessage, 'utf8');
              const lenBuf = Buffer.alloc(4);
              lenBuf.writeInt32BE(msgBuf.length, 0);
              sendPacket('p', Buffer.concat([mech, lenBuf, msgBuf]));
            } else if (authType === 11) {
              // SASLContinue
              const serverFirst = payload.toString('utf8', 4);
              const parts: Record<string, string> = {};
              for (const item of serverFirst.split(',')) {
                const idx = item.indexOf('=');
                if (idx > 0) parts[item.slice(0, idx)] = item.slice(idx + 1);
              }
              const rNonce = parts['r'] || '';
              const salt = Buffer.from(parts['s'] || '', 'base64');
              const iterations = parseInt(parts['i'] || '4096', 10);

              const saltedPassword = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
              const clientKey = crypto.createHmac('sha256', saltedPassword).update('Client Key').digest();
              const storedKey = crypto.createHash('sha256').update(clientKey).digest();
              const clientFinalWithoutProof = `c=biws,r=${rNonce}`;
              const authMessage = `${clientFirstMessageBare},${serverFirst},${clientFinalWithoutProof}`;
              const clientSignature = crypto.createHmac('sha256', storedKey).update(authMessage).digest();
              const clientProof = Buffer.alloc(clientKey.length);
              for (let i = 0; i < clientKey.length; i++) {
                clientProof[i] = clientKey[i] ^ clientSignature[i];
              }
              const clientFinal = `${clientFinalWithoutProof},p=${clientProof.toString('base64')}`;
              sendPacket('p', Buffer.from(clientFinal, 'utf8'));
            } else if (authType === 12) {
              // SASLFinal OK
            } else {
              fail(new Error(`Método de autenticación PostgreSQL no soportado (${authType})`));
            }
          } else if (msgType === 'Z') {
            // ReadyForQuery
            if (rows.length === 0 && !sqlQuerySent) {
              sqlQuerySent = true;
              sendQuery(sqlQuery);
            } else {
              done(rows);
            }
          } else if (msgType === 'D') {
            // DataRow
            const colCount = payload.readInt16BE(0);
            let offset = 2;
            const row: string[] = [];
            for (let c = 0; c < colCount; c++) {
              const len = payload.readInt32BE(offset);
              offset += 4;
              if (len === -1) {
                row.push('');
              } else {
                row.push(payload.toString('utf8', offset, offset + len));
                offset += len;
              }
            }
            rows.push(row);
          } else if (msgType === 'E') {
            // ErrorResponse
            let errMsg = 'Error en PostgreSQL remoto';
            let pos = 0;
            while (pos < payload.length && payload[pos] !== 0) {
              const code = String.fromCharCode(payload[pos]);
              const end = payload.indexOf(0, pos + 1);
              const val = payload.toString('utf8', pos + 1, end);
              if (code === 'M') errMsg = val;
              pos = end + 1;
            }
            fail(new Error(errMsg));
          }
        }
      });
    }

    let sqlQuerySent = false;

    socket.once('connect', () => {
      if (config.ssl) {
        // Solicitar SSLRequest (8 bytes: length=8, code=80877103)
        const sslReq = Buffer.alloc(8);
        sslReq.writeInt32BE(8, 0);
        sslReq.writeInt32BE(80877103, 4);
        socket.write(sslReq);
        socket.once('data', resp => {
          if (resp[0] === 0x53) {
            // 'S' -> upgrade to TLS
            const tlsSock = tls.connect({
              socket,
              servername: host,
              rejectUnauthorized: false
            });
            socket = tlsSock;
            tlsSock.on('error', fail);
            attachListeners(tlsSock);
            sendStartupMessage(tlsSock);
          } else {
            attachListeners(socket);
            sendStartupMessage(socket);
          }
        });
      } else {
        attachListeners(socket);
        sendStartupMessage(socket);
      }
    });
  });
}

/**
 * Extrae únicamente la estructura (metadatos de tablas, columnas, PKs y FKs)
 * desde un servidor PostgreSQL remoto sin descargar filas de datos para no sobrecargar la PC.
 */
async function fetchPostgresRemoteSchema(config: RemoteDbConfig): Promise<SqlSchema> {
  const targetSchema = (config.dbSchema || 'public').replace(/'/g, '');
  const filterClause = config.tableFilter
    ? `AND c.table_name LIKE '${config.tableFilter.replace(/'/g, '')}'`
    : '';

  const metadataQuery = `
    SELECT
      'COL' AS rec_type,
      c.table_name,
      c.column_name,
      UPPER(c.udt_name) || CASE WHEN c.character_maximum_length IS NOT NULL THEN '(' || c.character_maximum_length || ')' ELSE '' END AS col_type,
      c.is_nullable,
      CASE WHEN pk.column_name IS NOT NULL THEN '1' ELSE '0' END AS is_pk,
      '' AS ref_table,
      '' AS ref_col
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    LEFT JOIN (
      SELECT kcu.table_schema, kcu.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
    ) pk ON pk.table_schema = c.table_schema AND pk.table_name = c.table_name AND pk.column_name = c.column_name
    WHERE c.table_schema = '${targetSchema}'
      AND t.table_type = 'BASE TABLE'
      ${filterClause}
    UNION ALL
    SELECT
      'FK' AS rec_type,
      kcu.table_name,
      kcu.column_name,
      '' AS col_type,
      '' AS is_nullable,
      '0' AS is_pk,
      ccu.table_name AS ref_table,
      ccu.column_name AS ref_col
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = '${targetSchema}'
  `;

  const rows = await queryPostgresWire(config, metadataQuery);
  const tableMap = new Map<string, SqlTable>();
  const relations: SqlRelation[] = [];

  for (const r of rows) {
    const [recType, tableName, colName, colType, isNullable, isPk, refTable, refCol] = r;
    if (recType === 'COL') {
      let tbl = tableMap.get(tableName);
      if (!tbl) {
        const idx = tableMap.size;
        tbl = {
          name: tableName,
          columns: [],
          x: 60 + (idx % 5) * 330,
          y: 75 + Math.floor(idx / 5) * 240
        };
        tableMap.set(tableName, tbl);
      }
      tbl.columns.push({
        name: colName,
        type: colType || 'VARCHAR(255)',
        isPrimaryKey: isPk === '1',
        isNullable: isNullable === 'YES',
        isUnique: false
      });
    } else if (recType === 'FK' && tableName && refTable) {
      const id = `${tableName}.${colName}->${refTable}.${refCol}`;
      if (!relations.some(rel => rel.id === id)) {
        relations.push({
          id,
          fromTable: tableName,
          fromColumn: colName,
          toTable: refTable,
          toColumn: refCol
        });
      }
    }
  }

  return {
    dialect: 'postgres',
    tables: Array.from(tableMap.values()),
    relations
  };
}

/**
 * Conecta a una BD remota (PostgreSQL o URL remota) y devuelve únicamente la estructura ERD
 * ligera sin cargar datos pesados en la PC.
 */
export async function fetchRemoteDatabaseSchema(config: RemoteDbConfig): Promise<SqlSchema> {
  if (config.engine === 'url') {
    return fetchRemoteSqlUrl(config.host);
  }
  return fetchPostgresRemoteSchema(config);
}
