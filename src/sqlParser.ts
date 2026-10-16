export type SqlDialect = 'postgres' | 'mysql' | 'sqlite';

export interface SqlColumn {
  name: string;
  type: string;
  isPrimaryKey: boolean;
  isNullable: boolean;
  isUnique: boolean;
  defaultValue?: string;
}

export interface SqlTable {
  name: string;
  columns: SqlColumn[];
  x: number;
  y: number;
}

export interface SqlRelation {
  id: string;
  constraintName?: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  onDelete?: string;
}

export interface SqlSchema {
  dialect: SqlDialect;
  tables: SqlTable[];
  relations: SqlRelation[];
}

const LAYOUT_COMMENT_PREFIX = '-- @sql-erd-layout:';
const DIALECT_COMMENT_PREFIX = '-- @sql-erd-dialect:';

/**
 * Detect SQL dialect automatically from syntax cues or explicit comment.
 */
export function detectDialect(sql: string): SqlDialect {
  const dialectMatch = sql.match(/^--\s*@sql-erd-dialect:\s*(postgres|mysql|sqlite)/im);
  if (dialectMatch) {
    return dialectMatch[1].toLowerCase() as SqlDialect;
  }
  if (/AUTO_INCREMENT|ENGINE\s*=|`[^`]+`/i.test(sql)) {
    return 'mysql';
  }
  if (/AUTOINCREMENT| WITHOUT ROWID/i.test(sql)) {
    return 'sqlite';
  }
  if (/SERIAL|BIGSERIAL|UUID|TIMESTAMPTZ|::/i.test(sql)) {
    return 'postgres';
  }
  return 'postgres';
}

function unquoteIdentifier(raw: string): string {
  const trimmed = raw.trim();
  const parts = trimmed.split('.');
  const last = parts[parts.length - 1].trim();
  return last.replace(/^[`"'[]|[`"'\]]$/g, '');
}

/**
 * Split comma-separated top-level items inside CREATE TABLE (...) without breaking on DECIMAL(10,2)
 */
function splitTopLevelComma(body: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const prev = i > 0 ? body[i - 1] : '';

    if (ch === "'" && !inDoubleQuote && prev !== '\\') {
      inSingleQuote = !inSingleQuote;
    } else if (ch === '"' && !inSingleQuote && prev !== '\\') {
      inDoubleQuote = !inDoubleQuote;
    } else if (!inSingleQuote && !inDoubleQuote) {
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth = Math.max(0, depth - 1);
      } else if (ch === ',' && depth === 0) {
        if (current.trim()) {
          result.push(current.trim());
        }
        current = '';
        continue;
      }
    }
    current += ch;
  }

  if (current.trim()) {
    result.push(current.trim());
  }
  return result;
}

/**
 * Parse a .sql text into a structured SqlSchema (supports Postgres, MySQL, SQLite)
 */
export function parseSqlToSchema(sql: string): SqlSchema {
  const dialect = detectDialect(sql);
  const layoutMap: Record<string, { x: number; y: number }> = {};

  // 1. Extract saved layout coordinates if present
  const layoutRegex = /^\s*--\s*@sql-erd-layout:\s*(\{.*\})\s*$/gm;
  let layoutMatch: RegExpExecArray | null;
  while ((layoutMatch = layoutRegex.exec(sql)) !== null) {
    try {
      const parsed = JSON.parse(layoutMatch[1]);
      Object.assign(layoutMap, parsed);
    } catch {
      // Ignore malformed layout comment
    }
  }

  // Strip single-line and block comments for clean DDL parsing
  const cleanSql = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ');

  const tables: SqlTable[] = [];
  const relations: SqlRelation[] = [];

  // 2. Match CREATE TABLE blocks with balanced parentheses
  const createTableHeaderRegex = /CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s*\(/gi;
  let match: RegExpExecArray | null;

  while ((match = createTableHeaderRegex.exec(cleanSql)) !== null) {
    const tableName = unquoteIdentifier(match[1]);
    const openParenIndex = createTableHeaderRegex.lastIndex - 1;

    let depth = 0;
    let closeParenIndex = -1;
    for (let i = openParenIndex; i < cleanSql.length; i++) {
      if (cleanSql[i] === '(') {
        depth++;
      } else if (cleanSql[i] === ')') {
        depth--;
        if (depth === 0) {
          closeParenIndex = i;
          break;
        }
      }
    }

    if (closeParenIndex === -1) {
      continue;
    }

    const body = cleanSql.slice(openParenIndex + 1, closeParenIndex);
    const entries = splitTopLevelComma(body);
    const columns: SqlColumn[] = [];
    const tablePrimaryKeys = new Set<string>();

    for (const entry of entries) {
      const normalized = entry.replace(/\s+/g, ' ').trim();
      if (!normalized) {
        continue;
      }

      // Table-level PRIMARY KEY (col1, col2)
      const pkConstraintMatch = normalized.match(
        /^(?:CONSTRAINT\s+[^\s]+\s+)?PRIMARY\s+KEY\s*\(([^)]+)\)/i
      );
      if (pkConstraintMatch) {
        pkConstraintMatch[1]
          .split(',')
          .map(unquoteIdentifier)
          .forEach(col => tablePrimaryKeys.add(col));
        continue;
      }

      // Table-level FOREIGN KEY
      const fkConstraintMatch = normalized.match(
        /^(?:CONSTRAINT\s+([^\s]+)\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([^\s(]+)\s*\(([^)]+)\)(?:.*?\bON\s+DELETE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION))?/i
      );
      if (fkConstraintMatch) {
        const constraintName = fkConstraintMatch[1]
          ? unquoteIdentifier(fkConstraintMatch[1])
          : undefined;
        const fromColumn = unquoteIdentifier(fkConstraintMatch[2].split(',')[0]);
        const toTable = unquoteIdentifier(fkConstraintMatch[3]);
        const toColumn = unquoteIdentifier(fkConstraintMatch[4].split(',')[0]);
        const onDelete = fkConstraintMatch[5]?.toUpperCase();

        relations.push({
          id: `${tableName}.${fromColumn}->${toTable}.${toColumn}`,
          constraintName,
          fromTable: tableName,
          fromColumn,
          toTable,
          toColumn,
          onDelete
        });
        continue;
      }

      // Skip other table constraints (UNIQUE, CHECK, KEY, INDEX)
      if (/^(?:CONSTRAINT|UNIQUE|CHECK|INDEX|KEY|FULLTEXT)\b/i.test(normalized)) {
        continue;
      }

      // Column definition: col_name DATA_TYPE [constraints...]
      const colMatch = normalized.match(/^([^\s]+)\s+([a-zA-Z0-9_]+(?:\s*\([^)]+\))?(?:\s+UNSIGNED)?)(.*)$/i);
      if (!colMatch) {
        continue;
      }

      const colName = unquoteIdentifier(colMatch[1]);
      const colType = colMatch[2].trim().toUpperCase();
      const rest = colMatch[3] || '';

      const isPrimaryKey = /\bPRIMARY\s+KEY\b/i.test(rest);
      const isNotNull = /\bNOT\s+NULL\b/i.test(rest) || isPrimaryKey;
      const isUnique = /\bUNIQUE\b/i.test(rest);

      const defaultMatch = rest.match(/\bDEFAULT\s+([^\s,]+|'[^']*')/i);
      const defaultValue = defaultMatch ? defaultMatch[1] : undefined;

      // Inline REFERENCES target_table(target_col)
      const inlineRefMatch = rest.match(
        /\bREFERENCES\s+([^\s(]+)\s*\(([^)]+)\)(?:.*?\bON\s+DELETE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION))?/i
      );
      if (inlineRefMatch) {
        const toTable = unquoteIdentifier(inlineRefMatch[1]);
        const toColumn = unquoteIdentifier(inlineRefMatch[2]);
        const onDelete = inlineRefMatch[3]?.toUpperCase();
        relations.push({
          id: `${tableName}.${colName}->${toTable}.${toColumn}`,
          fromTable: tableName,
          fromColumn: colName,
          toTable,
          toColumn,
          onDelete
        });
      }

      columns.push({
        name: colName,
        type: colType,
        isPrimaryKey,
        isNullable: !isNotNull,
        isUnique,
        defaultValue
      });
    }

    for (const col of columns) {
      if (tablePrimaryKeys.has(col.name)) {
        col.isPrimaryKey = true;
        col.isNullable = false;
      }
    }

    // Auto-layout grid if no saved position
    const index = tables.length;
    const colIndex = index % 3;
    const rowIndex = Math.floor(index / 3);
    const savedPos = layoutMap[tableName];

    tables.push({
      name: tableName,
      columns,
      x: savedPos ? Math.round(savedPos.x) : 60 + colIndex * 340,
      y: savedPos ? Math.round(savedPos.y) : 60 + rowIndex * 280
    });
  }

  // 3. Match standalone ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY statements
  const alterFkRegex =
    /ALTER\s+TABLE\s+(?:ONLY\s+)?([^\s]+)\s+ADD\s+(?:CONSTRAINT\s+([^\s]+)\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([^\s(]+)\s*\(([^)]+)\)(?:.*?\bON\s+DELETE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION))?/gi;
  let alterMatch: RegExpExecArray | null;
  while ((alterMatch = alterFkRegex.exec(cleanSql)) !== null) {
    const fromTable = unquoteIdentifier(alterMatch[1]);
    const constraintName = alterMatch[2] ? unquoteIdentifier(alterMatch[2]) : undefined;
    const fromColumn = unquoteIdentifier(alterMatch[3].split(',')[0]);
    const toTable = unquoteIdentifier(alterMatch[4]);
    const toColumn = unquoteIdentifier(alterMatch[5].split(',')[0]);
    const onDelete = alterMatch[6]?.toUpperCase();

    const id = `${fromTable}.${fromColumn}->${toTable}.${toColumn}`;
    if (!relations.some(r => r.id === id)) {
      relations.push({
        id,
        constraintName,
        fromTable,
        fromColumn,
        toTable,
        toColumn,
        onDelete
      });
    }
  }

  return { dialect, tables, relations };
}

function quoteId(name: string, dialect: SqlDialect): string {
  if (dialect === 'mysql') {
    return `\`${name}\``;
  }
  return name;
}

/**
 * Serialize a SqlSchema back into clean, formatted SQL for the chosen dialect
 * while preserving layout coordinates in a footer comment.
 */
export function generateSqlFromSchema(schema: SqlSchema): string {
  const { dialect, tables, relations } = schema;
  const lines: string[] = [];

  lines.push(`${DIALECT_COMMENT_PREFIX} ${dialect}`);
  lines.push(`-- Generado y sincronizado por SQL ERD Visual Editor`);
  lines.push('');

  for (const table of tables) {
    const tableRels = relations.filter(r => r.fromTable === table.name);
    const colLines: string[] = [];

    for (const col of table.columns) {
      const parts: string[] = [
        `  ${quoteId(col.name, dialect)}`,
        col.type || 'VARCHAR(255)'
      ];

      if (col.isPrimaryKey) {
        parts.push('PRIMARY KEY');
      } else {
        if (!col.isNullable) {
          parts.push('NOT NULL');
        }
        if (col.isUnique) {
          parts.push('UNIQUE');
        }
      }

      if (col.defaultValue !== undefined && col.defaultValue !== '') {
        parts.push(`DEFAULT ${col.defaultValue}`);
      }

      // For SQLite, Foreign Keys must be inside CREATE TABLE
      if (dialect === 'sqlite') {
        const inlineRel = tableRels.find(r => r.fromColumn === col.name);
        if (inlineRel) {
          parts.push(
            `REFERENCES ${quoteId(inlineRel.toTable, dialect)}(${quoteId(inlineRel.toColumn, dialect)})${
              inlineRel.onDelete ? ` ON DELETE ${inlineRel.onDelete}` : ''
            }`
          );
        }
      }

      colLines.push(parts.join(' '));
    }

    // For Postgres / MySQL, we can include explicit FOREIGN KEY constraints inside CREATE TABLE
    if (dialect !== 'sqlite') {
      for (const rel of tableRels) {
        const fkName =
          rel.constraintName || `fk_${table.name}_${rel.fromColumn}`;
        const onDeleteClause = rel.onDelete ? ` ON DELETE ${rel.onDelete}` : '';
        colLines.push(
          `  CONSTRAINT ${quoteId(fkName, dialect)} FOREIGN KEY (${quoteId(
            rel.fromColumn,
            dialect
          )}) REFERENCES ${quoteId(rel.toTable, dialect)}(${quoteId(
            rel.toColumn,
            dialect
          )})${onDeleteClause}`
        );
      }
    }

    lines.push(`CREATE TABLE ${quoteId(table.name, dialect)} (`);
    lines.push(colLines.join(',\n'));
    lines.push(`)${dialect === 'mysql' ? ' ENGINE=InnoDB' : ''};`);
    lines.push('');
  }

  // Persist visual coordinates at the bottom
  const layoutObj: Record<string, { x: number; y: number }> = {};
  for (const t of tables) {
    layoutObj[t.name] = { x: Math.round(t.x), y: Math.round(t.y) };
  }
  lines.push(`${LAYOUT_COMMENT_PREFIX} ${JSON.stringify(layoutObj)}`);

  return lines.join('\n') + '\n';
}
