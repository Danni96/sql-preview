import * as vscode from 'vscode';
import {
  parseSqlToSchema,
  generateSqlFromSchema,
  SqlSchema
} from './sqlParser';

export function activate(context: vscode.ExtensionContext) {
  // Registrar el CustomTextEditorProvider para *.sql y *.ddl
  context.subscriptions.push(SqlErdEditorProvider.register(context));

  // Comando para abrir el diagrama en una pestaña dividida junto al texto SQL
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'sqlErd.openDiagramSideBySide',
      async (uri?: vscode.Uri) => {
        const targetUri =
          uri || vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) {
          vscode.window.showWarningMessage(
            'Abre primero un archivo .sql para visualizar su diagrama.'
          );
          return;
        }
        await vscode.commands.executeCommand(
          'vscode.openWith',
          targetUri,
          SqlErdEditorProvider.viewType,
          vscode.ViewColumn.Beside
        );
      }
    )
  );
}

export class SqlErdEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'sqlErd.diagramEditor';

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new SqlErdEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(
      SqlErdEditorProvider.viewType,
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true
    };

    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

    let isApplyingFromWebview = false;

    const sendSchemaToWebview = () => {
      const sqlText = document.getText();
      const schema = parseSqlToSchema(sqlText);
      webviewPanel.webview.postMessage({
        type: 'schemaUpdated',
        schema
      });
    };

    // Escuchar cambios en el archivo .sql (por ejemplo, si el usuario escribe código SQL a mano)
    const changeDocumentSubscription =
      vscode.workspace.onDidChangeTextDocument(e => {
        if (
          e.document.uri.toString() === document.uri.toString() &&
          !isApplyingFromWebview
        ) {
          sendSchemaToWebview();
        }
      });

    // Escuchar ediciones hechas desde el diagrama interactivo (Webview -> archivo .sql)
    webviewPanel.webview.onDidReceiveMessage(async message => {
      if (message.type === 'ready') {
        sendSchemaToWebview();
        return;
      }

      if (message.type === 'updateSchema') {
        const updatedSchema: SqlSchema = message.schema;
        const newSql = generateSqlFromSchema(updatedSchema);

        if (newSql === document.getText()) {
          return;
        }

        isApplyingFromWebview = true;
        try {
          const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
          );
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, fullRange, newSql);
          await vscode.workspace.applyEdit(edit);
        } finally {
          isApplyingFromWebview = false;
        }
      }
    });

    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
    });

    sendSchemaToWebview();
  }

  private getHtmlForWebview(_webview: vscode.Webview): string {
    return /* html */ `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SQL ERD Visual Editor</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #0f172a);
      --fg: var(--vscode-editor-foreground, #e2e8f0);
      --card: var(--vscode-editorWidget-background, #1e293b);
      --border: var(--vscode-panel-border, #334155);
      --accent: var(--vscode-button-background, #3b82f6);
      --accent-hover: var(--vscode-button-hoverBackground, #2563eb);
      --danger: #ef4444;
      --pk: #f59e0b;
      --fk: #38bdf8;
    }

    * { box-sizing: border-box; user-select: none; }

    body, html {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, system-ui, -apple-system, sans-serif);
      font-size: 12px;
    }

    /* Barra de herramientas superior */
    .toolbar {
      position: fixed;
      top: 12px;
      left: 12px;
      right: 12px;
      height: 44px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      display: flex;
      align-items: center;
      padding: 0 12px;
      gap: 10px;
      z-index: 100;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    }

    .toolbar-title {
      font-weight: 700;
      font-size: 13px;
      margin-right: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .toolbar select, .toolbar button {
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border);
      padding: 5px 10px;
      border-radius: 5px;
      cursor: pointer;
      font-size: 12px;
    }

    .toolbar button.primary {
      background: var(--accent);
      color: #fff;
      border-color: transparent;
      font-weight: 600;
    }

    .toolbar button.primary:hover {
      background: var(--accent-hover);
    }

    .toolbar-hint {
      margin-left: auto;
      opacity: 0.75;
      font-size: 11px;
    }

    /* Lienzo con cuadrícula */
    #viewport {
      width: 100vw;
      height: 100vh;
      position: relative;
      overflow: auto;
      background-image: radial-gradient(var(--border) 1px, transparent 1px);
      background-size: 20px 20px;
    }

    #canvas {
      position: relative;
      width: 3200px;
      height: 2400px;
    }

    svg#edges-layer {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 1;
    }

    svg#edges-layer path.edge-path {
      fill: none;
      stroke: var(--fk);
      stroke-width: 2.2px;
      pointer-events: stroke;
      cursor: pointer;
      transition: stroke 0.15s, stroke-width 0.15s;
    }

    svg#edges-layer path.edge-path:hover {
      stroke: var(--danger);
      stroke-width: 3.5px;
    }

    svg#edges-layer path.temp-edge {
      fill: none;
      stroke: var(--pk);
      stroke-width: 2px;
      stroke-dasharray: 5, 5;
    }

    /* Nodos de Tabla */
    .table-node {
      position: absolute;
      width: 280px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
      z-index: 2;
    }

    .table-header {
      background: rgba(59, 130, 246, 0.16);
      border-bottom: 1px solid var(--border);
      padding: 8px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: grab;
      border-radius: 8px 8px 0 0;
    }

    .table-header:active {
      cursor: grabbing;
    }

    .table-header input.table-name-input {
      background: transparent;
      border: 1px solid transparent;
      color: var(--fg);
      font-weight: 700;
      font-size: 13px;
      width: 190px;
      padding: 2px 4px;
      border-radius: 4px;
    }

    .table-header input.table-name-input:focus {
      border-color: var(--accent);
      background: var(--bg);
      outline: none;
    }

    .icon-btn {
      background: transparent;
      border: none;
      color: var(--fg);
      opacity: 0.65;
      cursor: pointer;
      padding: 2px 5px;
      border-radius: 4px;
      font-size: 12px;
    }

    .icon-btn:hover {
      opacity: 1;
      background: rgba(255, 255, 255, 0.08);
    }

    .icon-btn.danger:hover {
      color: var(--danger);
    }

    .column-row {
      position: relative;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 5px 12px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.12);
    }

    .column-row input.col-name {
      background: transparent;
      border: 1px solid transparent;
      color: var(--fg);
      width: 98px;
      font-size: 11.5px;
      padding: 2px 3px;
      border-radius: 3px;
    }

    .column-row input.col-type {
      background: rgba(15, 23, 42, 0.45);
      border: 1px solid var(--border);
      color: var(--fk);
      width: 82px;
      font-size: 10.5px;
      font-family: monospace;
      padding: 2px 4px;
      border-radius: 3px;
    }

    .column-row input:focus {
      border-color: var(--accent);
      background: var(--bg);
      outline: none;
    }

    .pk-badge {
      font-size: 10px;
      padding: 1px 4px;
      border-radius: 3px;
      cursor: pointer;
      border: 1px solid var(--border);
      opacity: 0.45;
      font-weight: 700;
    }

    .pk-badge.active {
      background: rgba(245, 158, 11, 0.2);
      border-color: var(--pk);
      color: var(--pk);
      opacity: 1;
    }

    /* Puntos de conexión (Ports) para arrastrar Foreign Keys */
    .port {
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: var(--bg);
      border: 2px solid var(--fk);
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      cursor: crosshair;
      z-index: 5;
      transition: transform 0.12s, background 0.12s;
    }

    .port:hover {
      transform: translateY(-50%) scale(1.35);
      background: var(--fk);
    }

    .port.port-target {
      left: -6px;
      border-color: var(--pk);
    }

    .port.port-source {
      right: -6px;
      border-color: var(--fk);
    }

    .table-footer {
      padding: 6px 10px;
      display: flex;
      justify-content: center;
    }

    .add-col-btn {
      width: 100%;
      background: transparent;
      border: 1px dashed var(--border);
      color: var(--fg);
      padding: 4px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      opacity: 0.8;
    }

    .add-col-btn:hover {
      opacity: 1;
      border-color: var(--accent);
      color: var(--accent);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="toolbar-title">🗄️ SQL ERD Editor</div>
    <label>
      Dialecto:
      <select id="dialect-select">
        <option value="postgres">PostgreSQL</option>
        <option value="mysql">MySQL / MariaDB</option>
        <option value="sqlite">SQLite</option>
      </select>
    </label>
    <button class="primary" id="add-table-btn">+ Nueva Tabla</button>
    <button id="auto-layout-btn">Auto-Ordenar</button>
    <div class="toolbar-hint">
      💡 Arrastra desde el círculo derecho (azul) de una columna hacia el círculo izquierdo (dorado) de otra tabla para crear un <b>FOREIGN KEY</b>. Haz clic en una línea para eliminarla.
    </div>
  </div>

  <div id="viewport">
    <div id="canvas">
      <svg id="edges-layer"></svg>
      <div id="nodes-layer"></div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    let schema = {
      dialect: 'postgres',
      tables: [],
      relations: []
    };

    // Estado para arrastrar tablas y conexiones FK
    let draggingTable = null;
    let dragOffset = { x: 0, y: 0 };
    let connectingFrom = null; // { table, column, startX, startY }

    const nodesLayer = document.getElementById('nodes-layer');
    const edgesLayer = document.getElementById('edges-layer');
    const dialectSelect = document.getElementById('dialect-select');
    const canvasEl = document.getElementById('canvas');

    function syncToExtension() {
      vscode.postMessage({
        type: 'updateSchema',
        schema
      });
    }

    // Obtener coordenadas de un puerto respecto al #canvas
    function getPortCenter(tableName, columnName, side) {
      const selector = \`[data-port-table="\${CSS.escape(tableName)}"][data-port-col="\${CSS.escape(columnName)}"][data-port-side="\${side}"]\`;
      const portEl = document.querySelector(selector);
      if (!portEl) return null;
      const canvasRect = canvasEl.getBoundingClientRect();
      const portRect = portEl.getBoundingClientRect();
      return {
        x: portRect.left - canvasRect.left + portRect.width / 2,
        y: portRect.top - canvasRect.top + portRect.height / 2
      };
    }

    function createBezierPath(x1, y1, x2, y2) {
      const dx = Math.max(Math.abs(x2 - x1) * 0.5, 60);
      return \`M \${x1} \${y1} C \${x1 + dx} \${y1}, \${x2 - dx} \${y2}, \${x2} \${y2}\`;
    }

    function renderEdges(tempMousePos = null) {
      edgesLayer.innerHTML = '';

      // Dibujar todas las relaciones FK existentes
      for (const rel of schema.relations) {
        const fromPt = getPortCenter(rel.fromTable, rel.fromColumn, 'source');
        const toPt = getPortCenter(rel.toTable, rel.toColumn, 'target');
        if (!fromPt || !toPt) continue;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'edge-path');
        path.setAttribute('d', createBezierPath(fromPt.x, fromPt.y, toPt.x, toPt.y));
        path.setAttribute('title', \`FK: \${rel.fromTable}.\${rel.fromColumn} → \${rel.toTable}.\${rel.toColumn} (Click para borrar)\`);

        path.addEventListener('click', (e) => {
          e.stopPropagation();
          schema.relations = schema.relations.filter(r => r.id !== rel.id);
          renderEdges();
          syncToExtension();
        });

        edgesLayer.appendChild(path);
      }

      // Línea temporal al arrastrar una nueva relación
      if (connectingFrom && tempMousePos) {
        const tempPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        tempPath.setAttribute('class', 'temp-edge');
        tempPath.setAttribute(
          'd',
          createBezierPath(connectingFrom.startX, connectingFrom.startY, tempMousePos.x, tempMousePos.y)
        );
        edgesLayer.appendChild(tempPath);
      }
    }

    function renderSchema() {
      dialectSelect.value = schema.dialect || 'postgres';
      nodesLayer.innerHTML = '';

      for (const table of schema.tables) {
        const node = document.createElement('div');
        node.className = 'table-node';
        node.style.left = \`\${table.x}px\`;
        node.style.top = \`\${table.y}px\`;

        // Cabecera de la tabla
        const header = document.createElement('div');
        header.className = 'table-header';

        const nameInput = document.createElement('input');
        nameInput.className = 'table-name-input';
        nameInput.value = table.name;
        nameInput.title = 'Renombrar tabla';
        nameInput.addEventListener('mousedown', e => e.stopPropagation());
        nameInput.addEventListener('change', () => {
          const oldName = table.name;
          const newName = nameInput.value.trim() || oldName;
          table.name = newName;
          for (const rel of schema.relations) {
            if (rel.fromTable === oldName) rel.fromTable = newName;
            if (rel.toTable === oldName) rel.toTable = newName;
            rel.id = \`\${rel.fromTable}.\${rel.fromColumn}->\${rel.toTable}.\${rel.toColumn}\`;
          }
          renderSchema();
          syncToExtension();
        });

        const deleteTableBtn = document.createElement('button');
        deleteTableBtn.className = 'icon-btn danger';
        deleteTableBtn.textContent = '✕';
        deleteTableBtn.title = 'Eliminar tabla';
        deleteTableBtn.addEventListener('mousedown', e => e.stopPropagation());
        deleteTableBtn.addEventListener('click', () => {
          schema.tables = schema.tables.filter(t => t !== table);
          schema.relations = schema.relations.filter(
            r => r.fromTable !== table.name && r.toTable !== table.name
          );
          renderSchema();
          syncToExtension();
        });

        header.appendChild(nameInput);
        header.appendChild(deleteTableBtn);

        // Iniciar arrastre de la tabla desde el header
        header.addEventListener('mousedown', e => {
          draggingTable = { table, nodeEl: node };
          const rect = node.getBoundingClientRect();
          dragOffset.x = e.clientX - rect.left;
          dragOffset.y = e.clientY - rect.top;
        });

        node.appendChild(header);

        // Lista de columnas
        for (const col of table.columns) {
          const row = document.createElement('div');
          row.className = 'column-row';

          // Puerto izquierdo (Target de FK / PK destino)
          const targetPort = document.createElement('div');
          targetPort.className = 'port port-target';
          targetPort.title = \`Conectar hacia \${table.name}.\${col.name}\`;
          targetPort.dataset.portTable = table.name;
          targetPort.dataset.portCol = col.name;
          targetPort.dataset.portSide = 'target';

          targetPort.addEventListener('mouseup', e => {
            e.stopPropagation();
            if (connectingFrom && connectingFrom.table !== table.name) {
              const id = \`\${connectingFrom.table}.\${connectingFrom.column}->\${table.name}.\${col.name}\`;
              if (!schema.relations.some(r => r.id === id)) {
                schema.relations.push({
                  id,
                  fromTable: connectingFrom.table,
                  fromColumn: connectingFrom.column,
                  toTable: table.name,
                  toColumn: col.name,
                  onDelete: 'CASCADE'
                });
                syncToExtension();
              }
            }
            connectingFrom = null;
            renderEdges();
          });

          // Botón PK
          const pkBadge = document.createElement('span');
          pkBadge.className = 'pk-badge' + (col.isPrimaryKey ? ' active' : '');
          pkBadge.textContent = 'PK';
          pkBadge.title = 'Alternar Primary Key';
          pkBadge.addEventListener('click', () => {
            col.isPrimaryKey = !col.isPrimaryKey;
            if (col.isPrimaryKey) col.isNullable = false;
            renderSchema();
            syncToExtension();
          });

          // Input nombre de columna
          const colNameInput = document.createElement('input');
          colNameInput.className = 'col-name';
          colNameInput.value = col.name;
          colNameInput.addEventListener('change', () => {
            const oldCol = col.name;
            const newCol = colNameInput.value.trim() || oldCol;
            col.name = newCol;
            for (const rel of schema.relations) {
              if (rel.fromTable === table.name && rel.fromColumn === oldCol) rel.fromColumn = newCol;
              if (rel.toTable === table.name && rel.toColumn === oldCol) rel.toColumn = newCol;
              rel.id = \`\${rel.fromTable}.\${rel.fromColumn}->\${rel.toTable}.\${rel.toColumn}\`;
            }
            renderSchema();
            syncToExtension();
          });

          // Input tipo de dato
          const colTypeInput = document.createElement('input');
          colTypeInput.className = 'col-type';
          colTypeInput.value = col.type;
          colTypeInput.addEventListener('change', () => {
            col.type = colTypeInput.value.trim().toUpperCase() || 'VARCHAR(255)';
            syncToExtension();
          });

          // Eliminar columna
          const delColBtn = document.createElement('button');
          delColBtn.className = 'icon-btn danger';
          delColBtn.textContent = '×';
          delColBtn.title = 'Eliminar columna';
          delColBtn.addEventListener('click', () => {
            table.columns = table.columns.filter(c => c !== col);
            schema.relations = schema.relations.filter(
              r =>
                !(r.fromTable === table.name && r.fromColumn === col.name) &&
                !(r.toTable === table.name && r.toColumn === col.name)
            );
            renderSchema();
            syncToExtension();
          });

          // Puerto derecho (Source de FK)
          const sourcePort = document.createElement('div');
          sourcePort.className = 'port port-source';
          sourcePort.title = \`Arrastrar desde \${table.name}.\${col.name} para crear Foreign Key\`;
          sourcePort.dataset.portTable = table.name;
          sourcePort.dataset.portCol = col.name;
          sourcePort.dataset.portSide = 'source';

          sourcePort.addEventListener('mousedown', e => {
            e.stopPropagation();
            const pt = getPortCenter(table.name, col.name, 'source');
            if (pt) {
              connectingFrom = {
                table: table.name,
                column: col.name,
                startX: pt.x,
                startY: pt.y
              };
            }
          });

          row.appendChild(targetPort);
          row.appendChild(pkBadge);
          row.appendChild(colNameInput);
          row.appendChild(colTypeInput);
          row.appendChild(delColBtn);
          row.appendChild(sourcePort);

          node.appendChild(row);
        }

        // Botón para agregar columna
        const footer = document.createElement('div');
        footer.className = 'table-footer';
        const addColBtn = document.createElement('button');
        addColBtn.className = 'add-col-btn';
        addColBtn.textContent = '+ Agregar Columna';
        addColBtn.addEventListener('click', () => {
          const nextNum = table.columns.length + 1;
          table.columns.push({
            name: \`col_\${nextNum}\`,
            type: 'VARCHAR(255)',
            isPrimaryKey: false,
            isNullable: true,
            isUnique: false
          });
          renderSchema();
          syncToExtension();
        });
        footer.appendChild(addColBtn);
        node.appendChild(footer);

        nodesLayer.appendChild(node);
      }

      requestAnimationFrame(() => renderEdges());
    }

    // Eventos globales del mouse para arrastrar tablas o conexiones
    window.addEventListener('mousemove', e => {
      const canvasRect = canvasEl.getBoundingClientRect();
      if (draggingTable) {
        const newX = Math.max(10, e.clientX - canvasRect.left - dragOffset.x);
        const newY = Math.max(64, e.clientY - canvasRect.top - dragOffset.y);
        draggingTable.table.x = Math.round(newX);
        draggingTable.table.y = Math.round(newY);
        draggingTable.nodeEl.style.left = \`\${draggingTable.table.x}px\`;
        draggingTable.nodeEl.style.top = \`\${draggingTable.table.y}px\`;
        renderEdges();
      } else if (connectingFrom) {
        renderEdges({
          x: e.clientX - canvasRect.left,
          y: e.clientY - canvasRect.top
        });
      }
    });

    window.addEventListener('mouseup', () => {
      if (draggingTable) {
        draggingTable = null;
        syncToExtension();
      }
      if (connectingFrom) {
        connectingFrom = null;
        renderEdges();
      }
    });

    // Cambiar dialecto SQL (Postgres / MySQL / SQLite)
    dialectSelect.addEventListener('change', () => {
      schema.dialect = dialectSelect.value;
      syncToExtension();
    });

    // Botón + Nueva Tabla
    document.getElementById('add-table-btn').addEventListener('click', () => {
      const index = schema.tables.length + 1;
      const pkType =
        schema.dialect === 'postgres'
          ? 'SERIAL'
          : schema.dialect === 'sqlite'
          ? 'INTEGER'
          : 'INT AUTO_INCREMENT';

      schema.tables.push({
        name: \`tabla_\${index}\`,
        x: 80 + ((index - 1) % 3) * 330,
        y: 80 + Math.floor((index - 1) / 3) * 260,
        columns: [
          {
            name: 'id',
            type: pkType,
            isPrimaryKey: true,
            isNullable: false,
            isUnique: true
          },
          {
            name: 'created_at',
            type: 'TIMESTAMP',
            isPrimaryKey: false,
            isNullable: false,
            isUnique: false
          }
        ]
      });
      renderSchema();
      syncToExtension();
    });

    // Botón Auto-Ordenar
    document.getElementById('auto-layout-btn').addEventListener('click', () => {
      schema.tables.forEach((t, idx) => {
        t.x = 70 + (idx % 3) * 340;
        t.y = 80 + Math.floor(idx / 3) * 280;
      });
      renderSchema();
      syncToExtension();
    });

    // Recibir actualizaciones desde la extensión cuando cambia el .sql
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'schemaUpdated') {
        schema = msg.schema;
        renderSchema();
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

export function deactivate() {}
