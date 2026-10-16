import assert from 'assert';
import {
  parseSqlToSchema,
  generateSqlFromSchema,
  detectDialect
} from '../sqlParser';
import {
  applyDeltaToSchema,
  SqlCollabRoomServer,
  SqlCollabNodeClient
} from '../collabServer';

async function runTests() {
  console.log('1. Probando detección y parseo en PostgreSQL...');
  const pgSql = `
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE
    );
    CREATE TABLE posts (
      id SERIAL PRIMARY KEY,
      author_id INT NOT NULL,
      title TEXT NOT NULL,
      CONSTRAINT fk_posts_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
    );
    -- @sql-erd-layout: {"users":{"x":120,"y":90},"posts":{"x":480,"y":90}}
  `;

  const schemaPg = parseSqlToSchema(pgSql);
  assert.strictEqual(schemaPg.dialect, 'postgres');
  assert.strictEqual(schemaPg.tables.length, 2);
  assert.strictEqual(schemaPg.relations.length, 1);
  assert.strictEqual(schemaPg.relations[0].fromTable, 'posts');
  assert.strictEqual(schemaPg.relations[0].fromColumn, 'author_id');
  assert.strictEqual(schemaPg.relations[0].toTable, 'users');
  assert.strictEqual(schemaPg.relations[0].toColumn, 'id');
  assert.strictEqual(schemaPg.tables[0].x, 120);

  console.log('2. Probando conversión y generación a MySQL (`ENGINE=InnoDB` y backticks)...');
  schemaPg.dialect = 'mysql';
  const mysqlOut = generateSqlFromSchema(schemaPg);
  assert.strictEqual(detectDialect(mysqlOut), 'mysql');
  assert.ok(mysqlOut.includes('CREATE TABLE `users`'));
  assert.ok(mysqlOut.includes('ENGINE=InnoDB'));

  const reparsedMysql = parseSqlToSchema(mysqlOut);
  assert.strictEqual(reparsedMysql.tables.length, 2);
  assert.strictEqual(reparsedMysql.relations.length, 1);

  console.log('3. Probando conversión y generación a SQLite (inline REFERENCES)...');
  reparsedMysql.dialect = 'sqlite';
  const sqliteOut = generateSqlFromSchema(reparsedMysql);
  assert.strictEqual(detectDialect(sqliteOut), 'sqlite');
  assert.ok(sqliteOut.includes('REFERENCES users(id)'));

  const reparsedSqlite = parseSqlToSchema(sqliteOut);
  assert.strictEqual(reparsedSqlite.tables.length, 2);
  assert.strictEqual(reparsedSqlite.relations.length, 1);

  console.log('4. Probando parseo de sintaxis DBML / DSL (bloques mnt_* con > tabla.col)...');
  const dbmlSample = `
mnt_instituciones {
	id string(26) pk
	codigo varchar(20) unique
	nombre varchar(255)
	tipo enum(interna,externa)
	nit varchar(25) null
}

mnt_establecimientos {
	id string(26) pk
	institucion_id string(26) > mnt_instituciones.id
	codigo varchar(20)
	direccion text null
}
  `;
  const parsedDbml = parseSqlToSchema(dbmlSample);
  assert.strictEqual(parsedDbml.dialect, 'dbml');
  assert.strictEqual(parsedDbml.tables.length, 2);
  assert.strictEqual(parsedDbml.tables[0].name, 'mnt_instituciones');
  assert.strictEqual(parsedDbml.tables[0].columns.length, 5);
  assert.strictEqual(parsedDbml.tables[0].columns[0].isPrimaryKey, true);
  assert.strictEqual(parsedDbml.tables[0].columns[1].isUnique, true);
  assert.strictEqual(parsedDbml.tables[0].columns[4].isNullable, true);
  assert.strictEqual(parsedDbml.relations.length, 1);
  assert.strictEqual(parsedDbml.relations[0].fromTable, 'mnt_establecimientos');
  assert.strictEqual(parsedDbml.relations[0].fromColumn, 'institucion_id');
  assert.strictEqual(parsedDbml.relations[0].toTable, 'mnt_instituciones');
  assert.strictEqual(parsedDbml.relations[0].toColumn, 'id');

  // Probar conversión de DBML a PostgreSQL
  parsedDbml.dialect = 'postgres';
  const convertedPg = generateSqlFromSchema(parsedDbml);
  assert.ok(convertedPg.includes('CREATE TABLE mnt_instituciones'));
  assert.ok(convertedPg.includes('FOREIGN KEY (institucion_id) REFERENCES mnt_instituciones(id)'));

  console.log('5. Probando operaciones concurrentes colaborativas (applyDeltaToSchema)...');
  applyDeltaToSchema(parsedDbml, {
    kind: 'moveTable',
    tableName: 'mnt_instituciones',
    x: 420,
    y: 180
  });
  assert.strictEqual(parsedDbml.tables[0].x, 420);

  applyDeltaToSchema(parsedDbml, {
    kind: 'addColumn',
    tableName: 'mnt_establecimientos',
    column: {
      name: 'telefono',
      type: 'VARCHAR(30)',
      isPrimaryKey: false,
      isNullable: true,
      isUnique: false
    }
  });
  assert.strictEqual(parsedDbml.tables[1].columns.length, 5);

  console.log('6. Probando sincronización bidireccional en vivo (Servidor Host <-> Cliente Invitado)...');
  await new Promise<void>(async (resolve, reject) => {
    let hostReceivedEdit = false;
    const server = new SqlCollabRoomServer(
      () => 'test.dbml',
      () => parsedDbml,
      delta => {
        if (applyDeltaToSchema(parsedDbml, delta)) {
          hostReceivedEdit = true;
        }
      },
      () => '<html></html>'
    );

    const port = await server.start(4591);
    const client = new SqlCollabNodeClient(`http://127.0.0.1:${port}`, 'Companero1', msg => {
      if (msg.type === 'delta' && msg.delta.kind === 'moveTable') {
        try {
          assert.ok(hostReceivedEdit, 'El Host recibió el cambio del invitado en vivo');
          assert.strictEqual(parsedDbml.tables[0].x, 777);
          client.disconnect();
          server.stop();
          resolve();
        } catch (err) {
          client.disconnect();
          server.stop();
          reject(err);
        }
      }
    });

    client.connect();
    setTimeout(() => {
      client.sendDelta({
        kind: 'moveTable',
        tableName: 'mnt_instituciones',
        x: 777,
        y: 333
      });
    }, 150);
  });

  console.log('✅ Todos los tests multi-dialecto y colaborativos en tiempo real pasaron exitosamente.');
}

runTests();
