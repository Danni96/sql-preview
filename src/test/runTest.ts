import assert from 'assert';
import {
  parseSqlToSchema,
  generateSqlFromSchema,
  detectDialect
} from '../sqlParser';

function runTests() {
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

  console.log('✅ Todos los tests multi-dialecto (Postgres, MySQL, SQLite) pasaron exitosamente.');
}

runTests();
