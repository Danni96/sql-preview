import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  parseSqlToSchema,
  generateSqlFromSchema,
  SqlSchema
} from './sqlParser';
import {
  SqlCollabRoomServer,
  SqlCollabNodeClient,
  fetchRoomInitialState,
  getAllLocalIps,
  applyDeltaToSchema,
  CollabDelta
} from './collabServer';
import {
  fetchRemoteDatabaseSchema,
  RemoteDbConfig
} from './remoteDbConnector';

// Mapa de archivos locales que se abrieron al unirse a una sala remota: normalizedPath -> roomInfo
const pendingJoinedRooms = new Map<string, { roomUrl: string; userName: string }>();
const activeEditorConnectors = new Map<string, (roomUrl: string, userName: string) => void>();
const activeRoomStoppers = new Set<() => void>();
let activeSidebarProvider: SqlErdSidebarProvider | null = null;

function normPathKey(fsPath: string): string {
  return path.resolve(fsPath).toLowerCase();
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(SqlErdEditorProvider.register(context));

  activeSidebarProvider = new SqlErdSidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SqlErdSidebarProvider.viewType,
      activeSidebarProvider
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'sqlErd.openDiagramSideBySide',
      async (uri?: vscode.Uri) => {
        const targetUri =
          uri || vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) {
          vscode.window.showWarningMessage(
            'Abre primero un archivo .sql o .dbml para visualizar su diagrama.'
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

  // Comando para que cualquier compañero se una a una sala (en modo Puente Ligero sin archivo local, o sincronizando archivo)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'sqlErd.joinCollabRoom',
      async (prefilledUrl?: string, bridgeOnlyMode = false) => {
        const roomUrl =
          prefilledUrl ||
          (await vscode.window.showInputBox({
            prompt: 'Ingresa la URL de la Sala / Puente Remoto (ej. http://192.168.1.50:4580)',
            placeHolder: 'http://localhost:4580'
          }));
        if (!roomUrl) {
          return;
        }

        const userName =
          (await vscode.window.showInputBox({
            prompt: 'Tu nombre para mostrar tu cursor en el diagrama',
            value: os.userInfo().username || 'Compañero'
          })) || 'Compañero';

        try {
          const cleanRoomUrl = roomUrl.trim().replace(/\/+$/, '');
          const state = await fetchRoomInitialState(cleanRoomUrl);

          // Si activó Modo Puente Ligero, abrir visor directo sin crear ni parsear archivo pesado en la PC
          if (bridgeOnlyMode) {
            SqlErdEditorProvider.openLightweightBridgePanel(
              cleanRoomUrl,
              userName,
              state.fileName || 'Puente Remoto',
              state.schema
            );
            return;
          }

          const workspaceDir =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.tmpdir();
          const safeName = path.basename(state.fileName || 'shared_schema.sql');
          const localFilePath = path.join(workspaceDir, safeName);

          fs.writeFileSync(localFilePath, state.sqlText, 'utf8');
          const fileUri = vscode.Uri.file(localFilePath);
          const key = normPathKey(localFilePath);

          pendingJoinedRooms.set(key, {
            roomUrl: cleanRoomUrl,
            userName
          });

          // 1. Abrir el archivo .sql/.dbml en texto a la izquierda
          const doc = await vscode.workspace.openTextDocument(fileUri);
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

          // 2. Abrir automáticamente el Diagrama Visual conectado en vivo a la derecha
          await vscode.commands.executeCommand(
            'vscode.openWith',
            fileUri,
            SqlErdEditorProvider.viewType,
            vscode.ViewColumn.Beside
          );

          // Si el editor ya estaba abierto, conectar de inmediato
          const existingConnector = activeEditorConnectors.get(key);
          if (existingConnector) {
            pendingJoinedRooms.delete(key);
            existingConnector(cleanRoomUrl, userName);
          }
        } catch (err) {
          vscode.window.showErrorMessage(
            `No se pudo conectar a la sala ${roomUrl}: ${String(err)}`
          );
        }
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

  /**
   * Abre un visor en Modo Puente Ligero (0 archivos pesados locales en la PC).
   * Toda la lógica y persistencia ocurre en el servidor remoto / anfitrión.
   */
  public static openLightweightBridgePanel(
    roomUrl: string,
    userName: string,
    title: string,
    initialSchema: SqlSchema
  ): void {
    const panel = vscode.window.createWebviewPanel(
      'sqlErd.bridgeViewer',
      `⚡ Puente Remoto: ${title}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const dummyProvider = new SqlErdEditorProvider({} as any);
    panel.webview.html = dummyProvider.getHtmlForWebview(panel.webview, false);

    let currentSchema = initialSchema;
    const client = new SqlCollabNodeClient(roomUrl, userName, msg => {
      if (msg.type === 'init' && msg.schema) {
        currentSchema = msg.schema;
        panel.webview.postMessage({ type: 'schemaUpdated', schema: currentSchema });
        if (Array.isArray(msg.peers)) {
          panel.webview.postMessage({ type: 'peersUpdated', peers: msg.peers });
          activeSidebarProvider?.notifyPeersUpdated(msg.peers);
        }
      } else if (msg.type === 'peers' && Array.isArray(msg.peers)) {
        panel.webview.postMessage({ type: 'peersUpdated', peers: msg.peers });
        activeSidebarProvider?.notifyPeersUpdated(msg.peers);
      } else if (msg.type === 'delta' && msg.peerId !== client.peerId) {
        const d: CollabDelta = msg.delta;
        if (d.kind === 'cursor') {
          panel.webview.postMessage({ type: 'remoteCursor', peer: d.peer });
        } else if (applyDeltaToSchema(currentSchema, d)) {
          panel.webview.postMessage({ type: 'schemaUpdated', schema: currentSchema });
        }
      }
    });

    const stopFn = () => {
      client.disconnect();
      panel.webview.postMessage({ type: 'roomStopped' });
      activeSidebarProvider?.notifyRoomStopped();
    };
    activeRoomStoppers.add(stopFn);

    panel.webview.onDidReceiveMessage(message => {
      if (message.type === 'ready') {
        panel.webview.postMessage({ type: 'schemaUpdated', schema: currentSchema });
        client.connect();
        panel.webview.postMessage({ type: 'joinedRoomSuccess', roomUrl });
      } else if (message.type === 'collabDelta' && message.delta) {
        client.sendDelta(message.delta);
      } else if (message.type === 'updateSchema' && message.schema) {
        currentSchema = message.schema;
        client.sendDelta({ kind: 'fullSchema', schema: currentSchema });
      } else if (message.type === 'updateLayoutOnly' && message.schema) {
        currentSchema = message.schema;
      } else if (message.type === 'stopHostRoom') {
        stopFn();
      }
    });

    panel.onDidDispose(() => {
      activeRoomStoppers.delete(stopFn);
      client.disconnect();
    });
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
    let debounceTimer: NodeJS.Timeout | undefined;
    let collabServer: SqlCollabRoomServer | null = null;
    let collabNodeClient: SqlCollabNodeClient | null = null;
    let currentSchemaCache: SqlSchema = parseSqlToSchema(document.getText());

    const connectGuestNodeClient = (roomUrl: string, userName: string) => {
      if (collabNodeClient) {
        collabNodeClient.disconnect();
      }
      collabNodeClient = new SqlCollabNodeClient(roomUrl, userName, async msg => {
        if (msg.type === 'init' && msg.schema) {
          await applySchemaToDocument(msg.schema);
          webviewPanel.webview.postMessage({
            type: 'schemaUpdated',
            schema: msg.schema
          });
          if (Array.isArray(msg.peers)) {
            webviewPanel.webview.postMessage({ type: 'peersUpdated', peers: msg.peers });
            activeSidebarProvider?.notifyPeersUpdated(msg.peers);
          }
        } else if (msg.type === 'peers' && Array.isArray(msg.peers)) {
          webviewPanel.webview.postMessage({ type: 'peersUpdated', peers: msg.peers });
          activeSidebarProvider?.notifyPeersUpdated(msg.peers);
        } else if (msg.type === 'delta' && msg.peerId !== collabNodeClient?.peerId) {
          const d: CollabDelta = msg.delta;
          if (d.kind === 'cursor') {
            webviewPanel.webview.postMessage({ type: 'remoteCursor', peer: d.peer });
          } else if (applyDeltaToSchema(currentSchemaCache, d)) {
            await applySchemaToDocument(currentSchemaCache);
            webviewPanel.webview.postMessage({
              type: 'schemaUpdated',
              schema: currentSchemaCache
            });
          }
        }
      });
      collabNodeClient.connect();
      webviewPanel.webview.postMessage({
        type: 'joinedRoomSuccess',
        roomUrl
      });
    };

    const docKey = normPathKey(document.uri.fsPath);
    activeEditorConnectors.set(docKey, connectGuestNodeClient);
    const stopCurrentCollabSession = () => {
      if (collabServer) {
        collabServer.stop();
        collabServer = null;
      }
      if (collabNodeClient) {
        collabNodeClient.disconnect();
        collabNodeClient = null;
      }
      webviewPanel.webview.postMessage({ type: 'roomStopped' });
      activeSidebarProvider?.notifyRoomStopped();
    };
    activeRoomStoppers.add(stopCurrentCollabSession);

    // Actualización quirúrgica de solo la línea @sql-erd-layout al mover tablas (evita reescribir miles de líneas en VS Code)
    const applyLayoutOnlyToDocument = async (updatedSchema: SqlSchema) => {
      currentSchemaCache = updatedSchema;
      const layoutObj: Record<string, { x: number; y: number }> = {};
      for (const t of updatedSchema.tables) {
        layoutObj[t.name] = { x: Math.round(t.x), y: Math.round(t.y) };
      }
      const prefix = updatedSchema.dialect === 'dbml' ? '// @sql-erd-layout:' : '-- @sql-erd-layout:';
      const newLayoutLine = `${prefix} ${JSON.stringify(layoutObj)}`;
      const text = document.getText();
      const layoutRegex = /^(\s*(?:--|\/\/)\s*@sql-erd-layout:\s*\{.*\})\s*$/m;
      const match = layoutRegex.exec(text);

      isApplyingFromWebview = true;
      try {
        const edit = new vscode.WorkspaceEdit();
        if (match && match.index !== undefined) {
          const startPos = document.positionAt(match.index);
          const endPos = document.positionAt(match.index + match[0].length);
          edit.replace(document.uri, new vscode.Range(startPos, endPos), newLayoutLine);
        } else {
          const endPos = document.positionAt(text.length);
          edit.insert(document.uri, endPos, `\n${newLayoutLine}\n`);
        }
        await vscode.workspace.applyEdit(edit);
      } finally {
        isApplyingFromWebview = false;
      }
    };

    const applySchemaToDocument = async (updatedSchema: SqlSchema) => {
      currentSchemaCache = updatedSchema;
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
    };

    const sendSchemaToWebview = () => {
      const sqlText = document.getText();
      currentSchemaCache = parseSqlToSchema(sqlText);
      webviewPanel.webview.postMessage({
        type: 'schemaUpdated',
        schema: currentSchemaCache
      });
      if (collabServer) {
        collabServer.broadcastSchema(currentSchemaCache, 'host');
      }
      if (collabNodeClient) {
        collabNodeClient.sendDelta({ kind: 'fullSchema', schema: currentSchemaCache });
      }
    };

    // Debounce de cambios de texto para no re-parsear en cada tecla si el archivo es enorme
    const changeDocumentSubscription =
      vscode.workspace.onDidChangeTextDocument(e => {
        if (
          e.document.uri.toString() === document.uri.toString() &&
          !isApplyingFromWebview
        ) {
          if (debounceTimer) {
            clearTimeout(debounceTimer);
          }
          debounceTimer = setTimeout(() => {
            sendSchemaToWebview();
          }, 250);
        }
      });

    webviewPanel.webview.onDidReceiveMessage(async message => {
      if (message.type === 'ready') {
        sendSchemaToWebview();
        const pending = pendingJoinedRooms.get(docKey);
        if (pending) {
          pendingJoinedRooms.delete(docKey);
          connectGuestNodeClient(pending.roomUrl, pending.userName);
        }
        return;
      }

      if (message.type === 'joinRemoteRoom') {
        const roomUrl = String(message.roomUrl || '').trim();
        if (roomUrl) {
          connectGuestNodeClient(roomUrl, os.userInfo().username || 'Dev');
          vscode.window.showInformationMessage(`Conectado en vivo a la sala ${roomUrl}`);
        }
        return;
      }

      if (message.type === 'collabDelta' && message.delta) {
        const d: CollabDelta = message.delta;
        if (d.kind !== 'cursor') {
          applyDeltaToSchema(currentSchemaCache, d);
        }
        if (collabServer) {
          collabServer.broadcastDeltaFromHost(d);
        }
        if (collabNodeClient) {
          collabNodeClient.sendDelta(d);
        }
        return;
      }

      if (message.type === 'startHostRoom') {
        try {
          if (!collabServer) {
            collabServer = new SqlCollabRoomServer(
              () => path.basename(document.uri.fsPath || 'schema.sql'),
              () => currentSchemaCache,
              async (delta: CollabDelta) => {
                if (delta.kind === 'cursor') {
                  webviewPanel.webview.postMessage({
                    type: 'remoteCursor',
                    peer: delta.peer
                  });
                  if (collabServer) {
                    const peers = collabServer.getPeers();
                    webviewPanel.webview.postMessage({
                      type: 'peersUpdated',
                      peers
                    });
                    activeSidebarProvider?.notifyPeersUpdated(peers);
                  }
                } else if (applyDeltaToSchema(currentSchemaCache, delta)) {
                  await applySchemaToDocument(currentSchemaCache);
                  webviewPanel.webview.postMessage({
                    type: 'schemaUpdated',
                    schema: currentSchemaCache
                  });
                }
              },
              () => this.getHtmlForWebview(webviewPanel.webview, true),
              peers => {
                webviewPanel.webview.postMessage({
                  type: 'peersUpdated',
                  peers
                });
                activeSidebarProvider?.notifyPeersUpdated(peers);
              }
            );
          }
          const port = await collabServer.start(4580);
          try {
            await vscode.env.asExternalUri(
              vscode.Uri.parse(`http://localhost:${port}`)
            );
          } catch {
            // ignore
          }
          const ips = getAllLocalIps();
          const bestIp = ips.length > 0 ? ips[0].address : 'localhost';
          const roomUrl = `http://${bestIp}:${port}`;
          const allUrls = ips.map(i => ({
            label: `${i.name}${i.isVirtual ? ' (Virtual/WSL)' : ' (LAN Wi-Fi/Red)'}`,
            url: `http://${i.address}:${port}`
          }));
          const initialPeers = collabServer.getPeers();
          webviewPanel.webview.postMessage({
            type: 'hostRoomStarted',
            roomUrl,
            port,
            allUrls,
            peers: initialPeers
          });
          if (activeSidebarProvider) {
            activeSidebarProvider.notifyHostStarted(roomUrl, port, allUrls, initialPeers);
          }
          vscode.env.clipboard.writeText(roomUrl);
          vscode.window.showInformationMessage(
            `Sala colaborativa activa en ${roomUrl} (copiada al portapapeles).`
          );
        } catch (err) {
          vscode.window.showErrorMessage(`Error al iniciar sala: ${String(err)}`);
        }
        return;
      }

      if (message.type === 'switchToScriptOnly') {
        await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
        webviewPanel.dispose();
        return;
      }

      if (message.type === 'stopHostRoom') {
        stopCurrentCollabSession();
        vscode.window.showInformationMessage('Sala colaborativa detenida.');
        return;
      }

      if (message.type === 'updateLayoutOnly') {
        const updatedSchema: SqlSchema = message.schema;
        await applyLayoutOnlyToDocument(updatedSchema);
        return;
      }

      if (message.type === 'updateSchema') {
        const updatedSchema: SqlSchema = message.schema;
        await applySchemaToDocument(updatedSchema);
        if (collabServer) {
          collabServer.broadcastSchema(updatedSchema, 'host');
        }
        if (collabNodeClient) {
          collabNodeClient.sendDelta({ kind: 'fullSchema', schema: updatedSchema });
        }
      }
    });

    webviewPanel.onDidDispose(() => {
      activeEditorConnectors.delete(docKey);
      activeRoomStoppers.delete(stopCurrentCollabSession);
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      if (collabServer) {
        collabServer.stop();
        collabServer = null;
      }
      if (collabNodeClient) {
        collabNodeClient.disconnect();
        collabNodeClient = null;
      }
      changeDocumentSubscription.dispose();
    });

    sendSchemaToWebview();
  }

  private getHtmlForWebview(_webview: vscode.Webview, isStandaloneWeb = false): string {
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
      display: flex;
      flex-direction: column;
    }

    .toolbar {
      flex-shrink: 0;
      width: 100%;
      background: var(--card);
      border-bottom: 1px solid var(--border);
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      padding: 6px 12px;
      gap: 8px;
      z-index: 100;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
    }

    .toolbar-title {
      font-weight: 700;
      font-size: 13px;
      margin-right: 4px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .toolbar select, .toolbar button, .toolbar input[type="text"] {
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border);
      padding: 4px 9px;
      border-radius: 5px;
      font-size: 11.5px;
    }

    .toolbar button, .toolbar select {
      cursor: pointer;
    }

    .toolbar button:hover {
      border-color: var(--accent);
    }

    .toolbar button.active-toggle {
      background: rgba(56, 189, 248, 0.18);
      border-color: var(--fk);
      color: var(--fk);
      font-weight: 600;
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

    .zoom-controls {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-left: auto;
    }

    #main-workspace {
      flex: 1;
      display: flex;
      width: 100%;
      height: 100%;
      overflow: hidden;
      position: relative;
    }

    #viewport {
      flex: 1;
      width: 100%;
      height: 100%;
      position: relative;
      overflow: hidden;
      background-color: var(--bg);
      cursor: grab;
    }

    #viewport.panning {
      cursor: grabbing;
    }

    body.is-interacting .table-node {
      box-shadow: none !important;
    }

    #canvas-scaler {
      position: absolute;
      top: 0;
      left: 0;
      z-index: 2;
      transform-origin: 0 0;
    }

    #canvas {
      position: relative;
      width: 8000px;
      height: 6000px;
    }

    canvas#edges-canvas {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 0;
    }

    /* Panel Explorador Progresivo acoplado a la izquierda sin tapar el lienzo */
    #explorer-drawer {
      flex-shrink: 0;
      width: 245px;
      height: 100%;
      background: var(--card);
      border-right: 1px solid var(--border);
      z-index: 95;
      display: none;
      flex-direction: column;
      overflow: hidden;
    }

    #explorer-drawer.open {
      display: flex;
    }

    .explorer-header {
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .explorer-list {
      flex: 1;
      overflow-y: auto;
      padding: 6px;
    }

    .explorer-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 6px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
    }

    .explorer-item:hover {
      background: rgba(255,255,255,0.06);
    }

    .ref-chip {
      font-size: 9.5px;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(56, 189, 248, 0.14);
      border: 1px solid rgba(56, 189, 248, 0.45);
      color: var(--fk);
      cursor: pointer;
      white-space: nowrap;
      max-width: 110px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .ref-chip:hover {
      background: var(--fk);
      color: #0f172a;
      font-weight: 700;
    }

    /* Tarjeta de Tabla ligera (sin will-change permanente para no saturar VRAM de la GPU) */
    .table-node {
      position: absolute;
      top: 0;
      left: 0;
      width: 280px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      z-index: 2;
      contain: layout style paint;
    }

    .table-node.selected-table {
      border-color: var(--pk);
      box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.35), 0 8px 24px rgba(0, 0, 0, 0.45);
      z-index: 10;
    }

    .table-header {
      height: 36px;
      background: rgba(59, 130, 246, 0.16);
      border-bottom: 1px solid var(--border);
      padding: 0 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: grab;
      border-radius: 7px 7px 0 0;
    }

    .table-header:active {
      cursor: grabbing;
    }

    .table-title-label {
      font-weight: 700;
      font-size: 12.5px;
      color: var(--fg);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 175px;
      cursor: grab;
      padding: 2px 4px;
      border-radius: 4px;
    }

    .table-title-label:hover {
      background: rgba(255, 255, 255, 0.06);
    }

    .icon-btn {
      background: transparent;
      border: none;
      color: var(--fg);
      opacity: 0.65;
      cursor: pointer;
      padding: 2px 5px;
      border-radius: 4px;
      font-size: 11px;
    }

    .icon-btn:hover {
      opacity: 1;
      background: rgba(255, 255, 255, 0.1);
    }

    .icon-btn.danger:hover {
      color: var(--danger);
    }

    .column-row {
      position: relative;
      height: 28px;
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 0 12px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.1);
    }

    .col-name-label {
      flex: 1;
      font-size: 11.5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: text;
      padding: 1px 3px;
      border-radius: 3px;
    }

    .col-type-label {
      font-size: 10.5px;
      font-family: monospace;
      color: var(--fk);
      background: rgba(15, 23, 42, 0.45);
      border: 1px solid var(--border);
      padding: 1px 5px;
      border-radius: 3px;
      max-width: 92px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: text;
    }

    .inline-edit-input {
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--accent);
      border-radius: 3px;
      font-size: 11.5px;
      padding: 1px 4px;
      width: 100px;
      outline: none;
    }

    .pk-badge {
      font-size: 9.5px;
      padding: 1px 4px;
      border-radius: 3px;
      cursor: pointer;
      border: 1px solid var(--border);
      opacity: 0.4;
      font-weight: 700;
    }

    .pk-badge.active {
      background: rgba(245, 158, 11, 0.2);
      border-color: var(--pk);
      color: var(--pk);
      opacity: 1;
    }

    .fk-badge {
      font-size: 9px;
      padding: 1px 3px;
      border-radius: 3px;
      background: rgba(56, 189, 248, 0.16);
      border: 1px solid var(--fk);
      color: var(--fk);
      font-weight: 700;
    }

    .port {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--bg);
      border: 2px solid var(--fk);
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      cursor: crosshair;
      z-index: 5;
    }

    .port:hover {
      transform: translateY(-50%) scale(1.4);
      background: var(--fk);
    }

    .port.port-target {
      left: -5px;
      border-color: var(--pk);
    }

    .port.port-source {
      right: -5px;
      border-color: var(--fk);
    }

    .table-footer {
      height: 30px;
      padding: 4px 8px;
      display: flex;
      gap: 6px;
      align-items: center;
      justify-content: space-between;
    }

    .add-col-btn, .more-cols-btn {
      flex: 1;
      background: transparent;
      border: 1px dashed var(--border);
      color: var(--fg);
      padding: 2px 6px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 10.5px;
      opacity: 0.8;
    }

    .add-col-btn:hover, .more-cols-btn:hover {
      opacity: 1;
      border-color: var(--accent);
      color: var(--accent);
    }

    /* Cursores colaborativos en tiempo real (+10 usuarios) */
    .peer-cursor {
      position: absolute;
      top: 0;
      left: 0;
      pointer-events: none;
      z-index: 50;
      will-change: transform;
      transition: transform 0.06s linear;
    }

    .peer-cursor-label {
      padding: 2px 6px;
      border-radius: 4px;
      color: #0f172a;
      font-weight: 700;
      font-size: 10px;
      white-space: nowrap;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    }

    .collab-bar {
      display: flex;
      align-items: center;
      gap: 5px;
      border-left: 1px solid var(--border);
      padding-left: 8px;
    }

    .peers-pill {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 12px;
      background: rgba(16, 185, 129, 0.16);
      border: 1px solid #10b981;
      color: #34d399;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="toolbar-title">🗄️ SQL / DBML ERD</div>
    <select id="dialect-select" title="Formato / Dialecto">
      <option value="dbml">DBML / DSL (Bloques)</option>
      <option value="postgres">PostgreSQL</option>
      <option value="mysql">MySQL / MariaDB</option>
      <option value="sqlite">SQLite</option>
    </select>
    <input id="search-input" type="text" placeholder="🔍 Filtrar tabla..." style="width:120px;" />
    <button id="explorer-btn" title="Opción 5: Explorador Progresivo (elegir qué tablas mostrar en el lienzo)">🗺️ Explorador</button>
    <select id="edge-mode-select" title="Opción 3: Preferencia de visualización de líneas y chips de relación">
      <option value="smart">🔗 Líneas: Cortas + Chips</option>
      <option value="selected">🔗 Líneas: Solo Seleccionada</option>
      <option value="chips">🔗 Líneas: Solo Chips (0 líneas)</option>
      <option value="all">🔗 Líneas: Todas</option>
    </select>
    <button id="compact-mode-btn" title="Muestra solo llaves PK/FK para acelerar esquemas grandes">⚡ Compacta</button>
    <button id="neighbors-btn" title="Al seleccionar una tabla, mostrar solo ella y sus tablas conectadas">🎯 Conectadas</button>
    <button class="primary" id="add-table-btn">+ Tabla</button>
    <button id="auto-layout-btn" title="Agrupar y ordenar tablas automáticamente">Auto-Ordenar</button>
    <button id="script-only-btn" title="Ocultar el diagrama visual y mostrar únicamente el código del script">📄 Solo Script</button>
    <div class="collab-bar">
      <button id="host-room-btn" title="Iniciar sala colaborativa en tiempo real para tu equipo (+10 usuarios)">🟢 Compartir Sala</button>
      <button id="stop-room-btn" style="display:none;background:rgba(239,68,68,0.2);border-color:#ef4444;color:#fca5a5;font-weight:600;" title="Detener o salir de la sala colaborativa">🔴 Detener Sala</button>
      <input id="join-url-input" type="text" placeholder="http://ip:4580" style="width:115px;" title="URL de la sala colaborativa" />
      <button id="join-room-btn" title="Conectar a la sala de un compañero">🔗 Unirse</button>
      <span id="peers-badge" class="peers-pill" style="display:none;"></span>
    </div>
    <span id="stats-badge" style="font-size:11px;opacity:0.85;"></span>
    <div class="zoom-controls">
      <button id="zoom-out-btn" title="Alejar">−</button>
      <span id="zoom-label" style="min-width:40px;text-align:center;font-size:11px;">100%</span>
      <button id="zoom-in-btn" title="Acercar">+</button>
      <button id="zoom-reset-btn" title="Restablecer Zoom">1:1</button>
    </div>
  </div>

  <div id="main-workspace">
    <div id="explorer-drawer">
      <div class="explorer-header">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <b style="font-size:12px;">🗺️ Explorador Progresivo</b>
          <div style="display:flex;align-items:center;gap:6px;">
            <span id="explorer-count" style="font-size:10.5px;opacity:0.8;"></span>
            <button id="explorer-close-btn" class="icon-btn danger" title="Cerrar panel explorador">✕</button>
          </div>
        </div>
        <input id="explorer-search" type="text" placeholder="Buscar en todas las tablas..." style="width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--border);padding:4px 7px;border-radius:4px;font-size:11px;" />
        <div style="display:flex;gap:4px;">
          <button id="exp-all-btn" style="flex:1;padding:3px;font-size:10.5px;cursor:pointer;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;">Ver Todas</button>
          <button id="exp-top25-btn" style="flex:1;padding:3px;font-size:10.5px;cursor:pointer;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;">Top 25</button>
          <button id="exp-clear-btn" style="flex:1;padding:3px;font-size:10.5px;cursor:pointer;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;">Limpiar</button>
        </div>
      </div>
      <div id="explorer-list" class="explorer-list"></div>
    </div>

    <div id="viewport">
      <canvas id="edges-canvas"></canvas>
      <div id="canvas-scaler">
        <div id="canvas">
          <div id="nodes-layer"></div>
          <div id="cursors-layer"></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const isStandaloneWeb = ${isStandaloneWeb ? 'true' : 'false'};
    const vscode = (!isStandaloneWeb && typeof acquireVsCodeApi === 'function')
      ? acquireVsCodeApi()
      : { postMessage: () => {} };

    const TABLE_WIDTH = 280;
    const HEADER_HEIGHT = 36;
    const ROW_HEIGHT = 28;

    let schema = {
      dialect: 'postgres',
      tables: [],
      relations: []
    };

    // Opciones de rendimiento y visualización (Opciones 3, 4 y 5)
    let compactMode = false;
    let autoCompactApplied = false;
    let isolateNeighbors = false;
    let edgeDisplayMode = 'smart'; // 'smart' | 'selected' | 'chips' | 'all'
    let progressiveSet = new Set(); // Tablas activas en el Explorador Progresivo
    let progressiveInitialized = false;
    let explorerFilter = '';
    let selectedTableName = null;
    let expandedTables = new Set();
    let zoomLevel = 1;
    let panX = 20;
    let panY = 20;
    let searchTerm = '';

    // Mapa matemático O(1) de coordenadas de puertos: key = "tableName.colName" -> { sourceX, sourceY, targetX, targetY }
    let portCoordsMap = new Map();
    let visibleTableNames = new Set();
    let tableNodeMap = new Map(); // tableName -> HTMLElement

    let draggingTable = null;
    let dragStartMouse = { x: 0, y: 0 };
    let dragStartTable = { x: 0, y: 0 };
    let isPanningCanvas = false;
    let panStartMouse = { x: 0, y: 0 };
    let panStartScroll = { left: 0, top: 0 };
    let connectingFrom = null;
    let rafPending = false;
    const viewportEl = document.getElementById('viewport');
    const nodesLayer = document.getElementById('nodes-layer');
    const edgesCanvas = document.getElementById('edges-canvas');
    const edgesCtx = edgesCanvas.getContext('2d');
    const dialectSelect = document.getElementById('dialect-select');
    const edgeModeSelect = document.getElementById('edge-mode-select');
    const explorerBtn = document.getElementById('explorer-btn');
    const explorerDrawer = document.getElementById('explorer-drawer');
    const explorerList = document.getElementById('explorer-list');
    const explorerSearch = document.getElementById('explorer-search');
    const explorerCount = document.getElementById('explorer-count');
    const searchInput = document.getElementById('search-input');
    const statsBadge = document.getElementById('stats-badge');
    const canvasEl = document.getElementById('canvas');
    const canvasScaler = document.getElementById('canvas-scaler');
    const compactBtn = document.getElementById('compact-mode-btn');
    const neighborsBtn = document.getElementById('neighbors-btn');
    const zoomLabel = document.getElementById('zoom-label');

    function applyCameraTransform() {
      canvasScaler.style.transform = \`translate3d(\${Math.round(panX)}px, \${Math.round(panY)}px, 0) scale(\${zoomLevel})\`;
    }

    function resizeEdgesCanvas() {
      const dpr = window.devicePixelRatio || 1;
      const rect = viewportEl.getBoundingClientRect();
      edgesCanvas.width = Math.max(1, rect.width) * dpr;
      edgesCanvas.height = Math.max(1, rect.height) * dpr;
      edgesCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      applyCameraTransform();
      renderEdges();
    }
    window.addEventListener('resize', resizeEdgesCanvas);

    edgeModeSelect.addEventListener('change', () => {
      edgeDisplayMode = edgeModeSelect.value;
      renderSchema();
    });

    explorerBtn.addEventListener('click', () => {
      explorerDrawer.classList.toggle('open');
      explorerBtn.classList.toggle('active-toggle', explorerDrawer.classList.contains('open'));
      renderExplorerList();
      requestAnimationFrame(resizeEdgesCanvas);
    });

    document.getElementById('explorer-close-btn').addEventListener('click', () => {
      explorerDrawer.classList.remove('open');
      explorerBtn.classList.remove('active-toggle');
      requestAnimationFrame(resizeEdgesCanvas);
    });

    explorerSearch.addEventListener('input', () => {
      explorerFilter = explorerSearch.value.trim().toLowerCase();
      renderExplorerList();
    });

    document.getElementById('exp-all-btn').addEventListener('click', () => {
      schema.tables.forEach(t => progressiveSet.add(t.name));
      renderExplorerList();
      renderSchema();
    });

    document.getElementById('exp-top25-btn').addEventListener('click', () => {
      progressiveSet.clear();
      schema.tables.slice(0, 25).forEach(t => progressiveSet.add(t.name));
      renderExplorerList();
      renderSchema();
    });

    document.getElementById('exp-clear-btn').addEventListener('click', () => {
      progressiveSet.clear();
      renderExplorerList();
      renderSchema();
    });

    function renderExplorerList() {
      if (!explorerDrawer.classList.contains('open')) return;
      explorerCount.textContent = \`\${progressiveSet.size}/\${schema.tables.length} activas\`;
      const frag = document.createDocumentFragment();
      for (const t of schema.tables) {
        if (explorerFilter && !t.name.toLowerCase().includes(explorerFilter)) continue;
        const item = document.createElement('label');
        item.className = 'explorer-item';
        const left = document.createElement('span');
        left.style.display = 'flex';
        left.style.alignItems = 'center';
        left.style.gap = '6px';
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = progressiveSet.has(t.name);
        chk.addEventListener('change', () => {
          if (chk.checked) progressiveSet.add(t.name);
          else progressiveSet.delete(t.name);
          explorerCount.textContent = \`\${progressiveSet.size}/\${schema.tables.length} activas\`;
          renderSchema();
        });
        const nameSpan = document.createElement('span');
        nameSpan.textContent = t.name;
        left.appendChild(chk);
        left.appendChild(nameSpan);

        const focusBtn = document.createElement('button');
        focusBtn.className = 'icon-btn';
        focusBtn.textContent = '🎯';
        focusBtn.title = 'Ir a esta tabla + traer sus conectadas';
        focusBtn.addEventListener('click', e => {
          e.preventDefault();
          e.stopPropagation();
          progressiveSet.add(t.name);
          for (const r of schema.relations) {
            if (r.fromTable === t.name) progressiveSet.add(r.toTable);
            if (r.toTable === t.name) progressiveSet.add(r.fromTable);
          }
          selectedTableName = t.name;
          renderExplorerList();
          renderSchema();
          panX = Math.round(viewportEl.clientWidth / 2 - (t.x + 140) * zoomLevel);
          panY = Math.round(viewportEl.clientHeight / 2 - (t.y + 80) * zoomLevel);
          applyCameraTransform();
          renderEdges();
          updateViewportCulling();
        });

        item.appendChild(left);
        item.appendChild(focusBtn);
        frag.appendChild(item);
      }
      explorerList.replaceChildren(frag);
    }

    function setZoom(newZoom) {
      zoomLevel = Math.max(0.2, Math.min(2.0, Math.round(newZoom * 20) / 20));
      applyCameraTransform();
      zoomLabel.textContent = \`\${Math.round(zoomLevel * 100)}%\`;
      renderEdges();
      updateViewportCulling();
    }

    document.getElementById('zoom-out-btn').addEventListener('click', () => setZoom(zoomLevel - 0.15));
    document.getElementById('zoom-in-btn').addEventListener('click', () => setZoom(zoomLevel + 0.15));
    document.getElementById('zoom-reset-btn').addEventListener('click', () => {
      panX = 20;
      panY = 20;
      setZoom(1);
    });

    // Rueda del ratón: con Ctrl/Cmd hace Zoom; sin Ctrl desplaza el lienzo libremente
    viewportEl.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        setZoom(zoomLevel + (e.deltaY < 0 ? 0.1 : -0.1));
      } else {
        panX -= e.deltaX;
        panY -= e.deltaY;
        applyCameraTransform();
        renderEdges();
        if (schema.tables.length > 30) updateViewportCulling();
      }
    }, { passive: false });

    compactBtn.addEventListener('click', () => {
      compactMode = !compactMode;
      expandedTables.clear();
      compactBtn.classList.toggle('active-toggle', compactMode);
      renderSchema();
    });

    neighborsBtn.addEventListener('click', () => {
      isolateNeighbors = !isolateNeighbors;
      neighborsBtn.classList.toggle('active-toggle', isolateNeighbors);
      renderSchema();
    });

    let searchDebounce = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        searchTerm = searchInput.value.trim().toLowerCase();
        renderSchema();
      }, 120);
    });

    function syncToExtension() {
      vscode.postMessage({
        type: 'updateSchema',
        schema
      });
      if (collabClientUrl) {
        sendCollabDelta({ kind: 'fullSchema', schema });
      }
    }

    // --- Motor Colaborativo en Tiempo Real (SSE + POST Deltas para +10 usuarios) ---
    const myPeerId = 'peer_' + Math.random().toString(36).slice(2, 9);
    const palette = ['#38bdf8', '#f59e0b', '#34d399', '#a78bfa', '#f472b6', '#fb7185', '#2dd4bf'];
    const myColor = palette[Math.floor(Math.random() * palette.length)];
    let myName = 'Dev-' + myPeerId.slice(-3);
    let collabClientUrl = isStandaloneWeb ? window.location.origin : '';
    let eventSource = null;
    let remotePeers = new Map();
    const cursorsLayer = document.getElementById('cursors-layer');
    const hostRoomBtn = document.getElementById('host-room-btn');
    const stopRoomBtn = document.getElementById('stop-room-btn');
    const joinUrlInput = document.getElementById('join-url-input');
    const joinRoomBtn = document.getElementById('join-room-btn');
    const peersBadge = document.getElementById('peers-badge');

    function renderPeersBadge(peers) {
      if (!Array.isArray(peers) || peers.length === 0) {
        peersBadge.style.display = 'none';
        return;
      }
      peersBadge.style.display = 'inline-flex';
      peersBadge.style.alignItems = 'center';
      peersBadge.style.gap = '6px';
      const names = peers
        .map(p => \`<span style="display:inline-flex;align-items:center;gap:3px;"><span style="width:7px;height:7px;border-radius:50%;background:\${p.color || '#38bdf8'};display:inline-block;"></span>\${p.name}</span>\`)
        .join(' · ');
      peersBadge.innerHTML = \`👥 \${peers.length}: \${names}\`;
    }

    let isCollabActive = isStandaloneWeb;
    let lastWebRevision = 0;

    function sendCollabDelta(delta) {
      if (isStandaloneWeb) {
        fetch(collabClientUrl + '/api/op', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ peerId: myPeerId, delta })
        }).catch(() => {});
      } else if (isCollabActive) {
        vscode.postMessage({ type: 'collabDelta', delta });
      }
    }

    function renderRemoteCursors() {
      const frag = document.createDocumentFragment();
      for (const [pid, p] of remotePeers.entries()) {
        if (pid === myPeerId) continue;
        const el = document.createElement('div');
        el.className = 'peer-cursor';
        el.style.transform = \`translate3d(\${p.x}px, \${p.y}px, 0)\`;
        const lbl = document.createElement('div');
        lbl.className = 'peer-cursor-label';
        lbl.style.background = p.color || '#38bdf8';
        lbl.textContent = p.activeTable ? \`↖ \${p.name} (\${p.activeTable})\` : \`↖ \${p.name}\`;
        el.appendChild(lbl);
        frag.appendChild(el);
      }
      cursorsLayer.replaceChildren(frag);
    }

    function connectToCollabRoom(baseUrl) {
      collabClientUrl = baseUrl.replace(/\\/+$/, '');
      if (eventSource) {
        eventSource.close();
      }
      const streamUrl = \`\${collabClientUrl}/api/events?peerId=\${encodeURIComponent(myPeerId)}&name=\${encodeURIComponent(myName)}&color=\${encodeURIComponent(myColor)}\`;
      eventSource = new EventSource(streamUrl);
      peersBadge.style.display = 'inline-block';
      joinRoomBtn.textContent = '🟢 Conectado';
      joinRoomBtn.classList.add('active-toggle');

      eventSource.onmessage = ev => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'init') {
            schema = msg.schema;
            renderSchema();
            if (Array.isArray(msg.peers)) {
              peersBadge.textContent = \`👥 \${msg.peers.length} en sala\`;
            }
          } else if (msg.type === 'peers' && Array.isArray(msg.peers)) {
            peersBadge.textContent = \`👥 \${msg.peers.length} en sala\`;
            const activeIds = new Set(msg.peers.map(p => p.peerId));
            for (const k of remotePeers.keys()) {
              if (!activeIds.has(k)) remotePeers.delete(k);
            }
            renderRemoteCursors();
          } else if (msg.type === 'delta' && msg.peerId !== myPeerId) {
            const d = msg.delta;
            if (d.kind === 'cursor') {
              remotePeers.set(d.peer.peerId, d.peer);
              renderRemoteCursors();
            } else if (d.kind === 'moveTable') {
              const tb = schema.tables.find(t => t.name === d.tableName);
              if (tb) {
                tb.x = d.x;
                tb.y = d.y;
                const nodeEl = tableNodeMap.get(tb.name);
                if (nodeEl) {
                  nodeEl.style.transform = \`translate3d(\${tb.x}px, \${tb.y}px, 0)\`;
                  recomputePortCoordinatesForTable(tb);
                  updateEdgesForTable(tb.name);
                } else {
                  renderSchema();
                }
              }
            } else if (d.kind === 'fullSchema') {
              schema = d.schema;
              renderSchema();
            }
          }
        } catch {}
      };
    }

    if (isStandaloneWeb) {
      hostRoomBtn.style.display = 'none';
      joinUrlInput.style.display = 'none';
      joinRoomBtn.style.display = 'none';
      connectToCollabRoom(window.location.origin);
      // Fallback polling en navegador cada 600ms por si algún proxy hace buffer de SSE
      setInterval(() => {
        fetch(\`\${window.location.origin}/api/state?since=\${lastWebRevision}&peerId=\${encodeURIComponent(myPeerId)}&name=\${encodeURIComponent(myName)}&color=\${encodeURIComponent(myColor)}\`)
          .then(r => r.json())
          .then(st => {
            if (Array.isArray(st.peers)) {
              peersBadge.textContent = \`👥 \${st.peers.length} en sala\`;
            }
            if (!st.unchanged && st.schema && st.revision > lastWebRevision) {
              lastWebRevision = st.revision;
              if (st.lastEditorPeerId !== myPeerId && !draggingTable) {
                schema = st.schema;
                renderSchema();
              }
            }
          })
          .catch(() => {});
      }, 600);
    } else {
      hostRoomBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'startHostRoom' });
      });
      document.getElementById('script-only-btn').addEventListener('click', () => {
        vscode.postMessage({ type: 'switchToScriptOnly' });
      });
      stopRoomBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'stopHostRoom' });
      });
      joinRoomBtn.addEventListener('click', () => {
        const url = joinUrlInput.value.trim();
        if (url) {
          vscode.postMessage({ type: 'joinRemoteRoom', roomUrl: url });
        }
      });
    }

    // Enviar movimiento de cursor colaborativo (throttled a ~15 envíos/seg)
    let lastCursorSent = 0;
    window.addEventListener('mousemove', e => {
      if (!isCollabActive) return;
      const now = Date.now();
      if (now - lastCursorSent < 65) return;
      lastCursorSent = now;
      const canvasRect = canvasEl.getBoundingClientRect();
      sendCollabDelta({
        kind: 'cursor',
        peer: {
          peerId: myPeerId,
          name: myName,
          color: myColor,
          x: Math.round((e.clientX - canvasRect.left) / zoomLevel),
          y: Math.round((e.clientY - canvasRect.top) / zoomLevel),
          activeTable: draggingTable ? draggingTable.table.name : (selectedTableName || undefined),
          lastSeen: now
        }
      });
    });

    function getFkColumnSet(tableName) {
      const set = new Set();
      for (const r of schema.relations) {
        if (r.fromTable === tableName) set.add(r.fromColumn);
        if (r.toTable === tableName) set.add(r.toColumn);
      }
      return set;
    }

    function getVisibleColumnsForTable(table) {
      if (!compactMode || expandedTables.has(table.name)) {
        return table.columns;
      }
      const fkCols = getFkColumnSet(table.name);
      const keyCols = table.columns.filter(c => c.isPrimaryKey || fkCols.has(c.name));
      return keyCols.length > 0 ? keyCols : table.columns.slice(0, 3);
    }

    // Cálculo matemático O(1) de coordenadas de puertos sin tocar getBoundingClientRect()
    function recomputePortCoordinatesForTable(table) {
      const visibleCols = getVisibleColumnsForTable(table);
      const visibleMap = new Map();
      visibleCols.forEach((c, idx) => visibleMap.set(c.name, idx));

      for (const col of table.columns) {
        const rowIndex = visibleMap.has(col.name) ? visibleMap.get(col.name) : 0;
        const cy = table.y + HEADER_HEIGHT + rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
        portCoordsMap.set(\`\${table.name}.\${col.name}\`, {
          targetX: table.x,
          targetY: cy,
          sourceX: table.x + TABLE_WIDTH,
          sourceY: cy
        });
      }
    }

    function createBezierPath(x1, y1, x2, y2) {
      const dx = Math.max(Math.abs(x2 - x1) * 0.45, 55);
      return \`M \${x1} \${y1} C \${x1 + dx} \${y1}, \${x2 - dx} \${y2}, \${x2} \${y2}\`;
    }

    // Opción 4 + Opción 3: Dibujo ultrarrápido en <canvas> 2D fijo del tamaño de la ventana (< 0.4ms)
    function updateEdgesForTable(_tableName) {
      renderEdges();
    }

    function renderEdges(tempMousePos = null) {
      if (!edgesCtx) return;
      const w = viewportEl.clientWidth || window.innerWidth;
      const h = viewportEl.clientHeight || window.innerHeight;
      edgesCtx.clearRect(0, 0, w, h);

      if (edgeDisplayMode === 'chips' && !connectingFrom) {
        return;
      }

      for (const rel of schema.relations) {
        if (!visibleTableNames.has(rel.fromTable) || !visibleTableNames.has(rel.toTable)) {
          continue;
        }

        const isSelectedRel =
          selectedTableName &&
          (rel.fromTable === selectedTableName || rel.toTable === selectedTableName);

        if (edgeDisplayMode === 'selected' && !isSelectedRel) {
          continue;
        }

        const fromPt = portCoordsMap.get(\`\${rel.fromTable}.\${rel.fromColumn}\`);
        const toPt = portCoordsMap.get(\`\${rel.toTable}.\${rel.toColumn}\`);
        if (!fromPt || !toPt) continue;

        const dist = Math.hypot(toPt.targetX - fromPt.sourceX, toPt.targetY - fromPt.sourceY);

        if (edgeDisplayMode === 'smart' && dist > 950 && !isSelectedRel) {
          continue;
        }

        // Convertir coordenadas del mundo a coordenadas del viewport usando panX / panY libres
        const x1 = fromPt.sourceX * zoomLevel + panX;
        const y1 = fromPt.sourceY * zoomLevel + panY;
        const x2 = toPt.targetX * zoomLevel + panX;
        const y2 = toPt.targetY * zoomLevel + panY;

        if (
          (x1 < -100 && x2 < -100) ||
          (x1 > w + 100 && x2 > w + 100) ||
          (y1 < -100 && y2 < -100) ||
          (y1 > h + 100 && y2 > h + 100)
        ) {
          continue;
        }

        const dx = Math.max(Math.abs(x2 - x1) * 0.45, 45 * zoomLevel);
        edgesCtx.beginPath();
        edgesCtx.moveTo(x1, y1);
        edgesCtx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2);

        if (isSelectedRel) {
          edgesCtx.strokeStyle = '#f59e0b';
          edgesCtx.lineWidth = 2.8;
          edgesCtx.globalAlpha = 1;
        } else if (selectedTableName) {
          edgesCtx.strokeStyle = '#38bdf8';
          edgesCtx.lineWidth = 1.6;
          edgesCtx.globalAlpha = 0.16;
        } else {
          edgesCtx.strokeStyle = '#38bdf8';
          edgesCtx.lineWidth = 1.8;
          edgesCtx.globalAlpha = 0.65;
        }
        edgesCtx.stroke();
      }

      if (connectingFrom && tempMousePos) {
        const x1 = connectingFrom.startX * zoomLevel + panX;
        const y1 = connectingFrom.startY * zoomLevel + panY;
        const x2 = tempMousePos.x * zoomLevel + panX;
        const y2 = tempMousePos.y * zoomLevel + panY;
        const dx = Math.max(Math.abs(x2 - x1) * 0.45, 45 * zoomLevel);

        edgesCtx.beginPath();
        edgesCtx.setLineDash([5, 5]);
        edgesCtx.moveTo(x1, y1);
        edgesCtx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2);
        edgesCtx.strokeStyle = '#f59e0b';
        edgesCtx.lineWidth = 2.2;
        edgesCtx.globalAlpha = 1;
        edgesCtx.stroke();
        edgesCtx.setLineDash([]);
      }
      edgesCtx.globalAlpha = 1;
    }

    // Edición inline ligera bajo demanda (no crea miles de <input> al inicio)
    function makeEditableLabel(el, initialValue, onCommit) {
      el.addEventListener('dblclick', e => {
        e.stopPropagation();
        const input = document.createElement('input');
        input.className = 'inline-edit-input';
        input.value = initialValue;
        el.replaceWith(input);
        input.focus();
        input.select();

        let committed = false;
        const finish = () => {
          if (committed) return;
          committed = true;
          const nextVal = input.value.trim() || initialValue;
          onCommit(nextVal);
        };
        input.addEventListener('blur', finish);
        input.addEventListener('keydown', ke => {
          if (ke.key === 'Enter') finish();
          if (ke.key === 'Escape') {
            committed = true;
            renderSchema();
          }
        });
      });
    }

    function renderSchema() {
      dialectSelect.value = schema.dialect || 'postgres';

      // Si el esquema tiene muchas tablas (>25), activar Vista Compacta y Explorador Progresivo inicialmente
      if (!autoCompactApplied && schema.tables.length > 25) {
        compactMode = true;
        autoCompactApplied = true;
        compactBtn.classList.add('active-toggle');
      }

      if (!progressiveInitialized && schema.tables.length > 0) {
        progressiveInitialized = true;
        // Cargar todas las tablas sin abrir el recuadro encima; el usuario abre "🗺️ Explorador" solo cuando quiera filtrar
        schema.tables.forEach(t => progressiveSet.add(t.name));
      } else if (progressiveInitialized) {
        if (progressiveSet.size === 0) {
          schema.tables.forEach(t => progressiveSet.add(t.name));
        }
      }

      renderExplorerList();

      portCoordsMap.clear();
      visibleTableNames.clear();
      tableNodeMap.clear();

      // Determinar conjunto de tablas conectadas si isolateNeighbors está activo
      let neighborSet = null;
      if (isolateNeighbors && selectedTableName) {
        neighborSet = new Set([selectedTableName]);
        for (const r of schema.relations) {
          if (r.fromTable === selectedTableName) neighborSet.add(r.toTable);
          if (r.toTable === selectedTableName) neighborSet.add(r.fromTable);
        }
      }

      let maxX = 2400;
      let maxY = 1800;
      const nodesFrag = document.createDocumentFragment();

      for (const table of schema.tables) {
        if (!searchTerm && !progressiveSet.has(table.name)) {
          continue;
        }
        if (searchTerm && !table.name.toLowerCase().includes(searchTerm)) {
          continue;
        }
        if (neighborSet && !neighborSet.has(table.name)) {
          continue;
        }

        visibleTableNames.add(table.name);
        recomputePortCoordinatesForTable(table);

        const visibleCols = getVisibleColumnsForTable(table);
        const hiddenCount = table.columns.length - visibleCols.length;
        const fkSet = getFkColumnSet(table.name);

        const estHeight = HEADER_HEIGHT + visibleCols.length * ROW_HEIGHT + 36;
        if (table.x + 360 > maxX) maxX = table.x + 360;
        if (table.y + estHeight + 160 > maxY) maxY = table.y + estHeight + 160;

        const node = document.createElement('div');
        node.className = 'table-node' + (selectedTableName === table.name ? ' selected-table' : '');
        node.style.transform = \`translate3d(\${table.x}px, \${table.y}px, 0)\`;
        tableNodeMap.set(table.name, node);

        node.addEventListener('mousedown', e => {
          if (selectedTableName !== table.name) {
            selectedTableName = table.name;
            document.querySelectorAll('.table-node.selected-table').forEach(el => el.classList.remove('selected-table'));
            node.classList.add('selected-table');
            if (isolateNeighbors) {
              renderSchema();
            } else {
              renderEdges();
            }
          }
          // Permitir arrastrar la tabla tomándola desde cualquier parte de la tarjeta (excepto puertos, botones o inputs)
          const tag = e.target.tagName;
          const cls = e.target.className || '';
          if (
            tag === 'INPUT' ||
            tag === 'BUTTON' ||
            (typeof cls === 'string' && (cls.includes('port') || cls.includes('pk-badge') || cls.includes('ref-chip')))
          ) {
            return;
          }
          e.stopPropagation();
          draggingTable = { table, nodeEl: node };
          dragStartMouse.x = e.clientX;
          dragStartMouse.y = e.clientY;
          dragStartTable.x = table.x;
          dragStartTable.y = table.y;
          document.body.classList.add('is-interacting');
        });

        // Header
        const header = document.createElement('div');
        header.className = 'table-header';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'table-title-label';
        titleSpan.textContent = table.name;
        titleSpan.title = \`\${table.name} (Doble clic para renombrar)\`;
        makeEditableLabel(titleSpan, table.name, newName => {
          const oldName = table.name;
          table.name = newName;
          for (const rel of schema.relations) {
            if (rel.fromTable === oldName) rel.fromTable = newName;
            if (rel.toTable === oldName) rel.toTable = newName;
            rel.id = \`\${rel.fromTable}.\${rel.fromColumn}->\${rel.toTable}.\${rel.toColumn}\`;
          }
          renderSchema();
          syncToExtension();
        });

        const headerActions = document.createElement('div');
        headerActions.style.display = 'flex';
        headerActions.style.gap = '2px';

        // Botón Opción 5: Traer al lienzo todas las tablas conectadas a esta tabla
        const bringNeighborsBtn = document.createElement('button');
        bringNeighborsBtn.className = 'icon-btn';
        bringNeighborsBtn.textContent = '🔗+';
        bringNeighborsBtn.title = 'Traer al lienzo todas las tablas conectadas con esta';
        bringNeighborsBtn.addEventListener('mousedown', e => e.stopPropagation());
        bringNeighborsBtn.addEventListener('click', () => {
          for (const r of schema.relations) {
            if (r.fromTable === table.name) progressiveSet.add(r.toTable);
            if (r.toTable === table.name) progressiveSet.add(r.fromTable);
          }
          selectedTableName = table.name;
          renderSchema();
        });
        headerActions.appendChild(bringNeighborsBtn);

        if (compactMode && table.columns.length > visibleCols.length) {
          const expandBtn = document.createElement('button');
          expandBtn.className = 'icon-btn';
          expandBtn.textContent = \`+\${hiddenCount}\`;
          expandBtn.title = \`Mostrar las \${table.columns.length} columnas\`;
          expandBtn.addEventListener('mousedown', e => e.stopPropagation());
          expandBtn.addEventListener('click', () => {
            expandedTables.add(table.name);
            renderSchema();
          });
          headerActions.appendChild(expandBtn);
        } else if (compactMode && expandedTables.has(table.name)) {
          const collapseBtn = document.createElement('button');
          collapseBtn.className = 'icon-btn';
          collapseBtn.textContent = '▴';
          collapseBtn.title = 'Compactar tabla';
          collapseBtn.addEventListener('mousedown', e => e.stopPropagation());
          collapseBtn.addEventListener('click', () => {
            expandedTables.delete(table.name);
            renderSchema();
          });
          headerActions.appendChild(collapseBtn);
        }

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
        headerActions.appendChild(deleteTableBtn);

        header.appendChild(titleSpan);
        header.appendChild(headerActions);

        // Iniciar arrastre fluido con GPU transform
        header.addEventListener('mousedown', e => {
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
          e.stopPropagation();
          draggingTable = { table, nodeEl: node };
          dragStartMouse.x = e.clientX;
          dragStartMouse.y = e.clientY;
          dragStartTable.x = table.x;
          dragStartTable.y = table.y;
          document.body.classList.add('is-interacting');
        });

        node.appendChild(header);

        // Columnas visibles
        for (const col of visibleCols) {
          const row = document.createElement('div');
          row.className = 'column-row';

          // Puerto izquierdo (Target)
          const targetPort = document.createElement('div');
          targetPort.className = 'port port-target';
          targetPort.title = \`Conectar hacia \${table.name}.\${col.name}\`;
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
                renderSchema();
                syncToExtension();
                connectingFrom = null;
                return;
              }
            }
            connectingFrom = null;
            renderEdges();
          });

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

          const colNameSpan = document.createElement('span');
          colNameSpan.className = 'col-name-label';
          colNameSpan.textContent = col.name;
          colNameSpan.title = \`\${col.name} (Doble clic para renombrar)\`;
          makeEditableLabel(colNameSpan, col.name, newCol => {
            const oldCol = col.name;
            col.name = newCol;
            for (const rel of schema.relations) {
              if (rel.fromTable === table.name && rel.fromColumn === oldCol) rel.fromColumn = newCol;
              if (rel.toTable === table.name && rel.toColumn === oldCol) rel.toColumn = newCol;
              rel.id = \`\${rel.fromTable}.\${rel.fromColumn}->\${rel.toTable}.\${rel.toColumn}\`;
            }
            renderSchema();
            syncToExtension();
          });

          const colTypeSpan = document.createElement('span');
          colTypeSpan.className = 'col-type-label';
          colTypeSpan.textContent = col.type;
          colTypeSpan.title = \`Tipo: \${col.type} (Doble clic para editar)\`;
          makeEditableLabel(colTypeSpan, col.type, newType => {
            col.type = newType;
            renderSchema();
            syncToExtension();
          });

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

          // Puerto derecho (Source)
          const sourcePort = document.createElement('div');
          sourcePort.className = 'port port-source';
          sourcePort.title = \`Arrastrar desde \${table.name}.\${col.name} para crear Foreign Key\`;
          sourcePort.addEventListener('mousedown', e => {
            e.stopPropagation();
            const pt = portCoordsMap.get(\`\${table.name}.\${col.name}\`);
            if (pt) {
              connectingFrom = {
                table: table.name,
                column: col.name,
                startX: pt.sourceX,
                startY: pt.sourceY
              };
            }
          });

          row.appendChild(targetPort);
          row.appendChild(pkBadge);
          if (fkSet.has(col.name) && !col.isPrimaryKey) {
            const outRel = schema.relations.find(
              r => r.fromTable === table.name && r.fromColumn === col.name
            );
            if (outRel) {
              // Opción 3: Chip de referencia clicable (-> tabla_destino) + clic derecho para eliminar FK
              const refChip = document.createElement('span');
              refChip.className = 'ref-chip';
              refChip.textContent = \`→ \${outRel.toTable}\`;
              refChip.title = \`FK hacia \${outRel.toTable}.\${outRel.toColumn} (Clic: ir a la tabla | Clic derecho: eliminar FK)\`;
              refChip.addEventListener('click', e => {
                e.stopPropagation();
                progressiveSet.add(outRel.toTable);
                selectedTableName = outRel.toTable;
                renderSchema();
                const targetTbl = schema.tables.find(t => t.name === outRel.toTable);
                if (targetTbl) {
                  panX = Math.round(viewportEl.clientWidth / 2 - (targetTbl.x + 140) * zoomLevel);
                  panY = Math.round(viewportEl.clientHeight / 2 - (targetTbl.y + 80) * zoomLevel);
                  applyCameraTransform();
                  renderEdges();
                  updateViewportCulling();
                }
              });
              refChip.addEventListener('contextmenu', e => {
                e.preventDefault();
                e.stopPropagation();
                schema.relations = schema.relations.filter(r => r.id !== outRel.id);
                renderSchema();
                syncToExtension();
              });
              row.appendChild(refChip);
            } else {
              const fkBadge = document.createElement('span');
              fkBadge.className = 'fk-badge';
              fkBadge.textContent = 'FK';
              row.appendChild(fkBadge);
            }
          }
          row.appendChild(colNameSpan);
          row.appendChild(colTypeSpan);
          row.appendChild(delColBtn);
          row.appendChild(sourcePort);

          node.appendChild(row);
        }

        // Footer
        const footer = document.createElement('div');
        footer.className = 'table-footer';

        if (hiddenCount > 0) {
          const moreBtn = document.createElement('button');
          moreBtn.className = 'more-cols-btn';
          moreBtn.textContent = \`▾ Ver \${hiddenCount} col. más\`;
          moreBtn.addEventListener('click', () => {
            expandedTables.add(table.name);
            renderSchema();
          });
          footer.appendChild(moreBtn);
        }

        const addColBtn = document.createElement('button');
        addColBtn.className = 'add-col-btn';
        addColBtn.textContent = '+ Columna';
        addColBtn.addEventListener('click', () => {
          const nextNum = table.columns.length + 1;
          table.columns.push({
            name: \`col_\${nextNum}\`,
            type: schema.dialect === 'dbml' ? 'varchar(100)' : 'VARCHAR(100)',
            isPrimaryKey: false,
            isNullable: true,
            isUnique: false
          });
          expandedTables.add(table.name);
          renderSchema();
          syncToExtension();
        });
        footer.appendChild(addColBtn);
        node.appendChild(footer);

        nodesFrag.appendChild(node);
      }

      canvasEl.style.width = \`\${maxX}px\`;
      canvasEl.style.height = \`\${maxY}px\`;
      statsBadge.textContent = \`\${visibleTableNames.size}/\${schema.tables.length} tablas · \${schema.relations.length} FKs\`;

      nodesLayer.replaceChildren(nodesFrag);
      renderEdges();
      updateViewportCulling();
    }

    // Virtualización de Pantalla (Viewport Frustum Culling con panX / panY infinito):
    function updateViewportCulling() {
      if (schema.tables.length <= 30) return;
      const margin = 420;
      const viewLeft = (-panX) / zoomLevel - margin;
      const viewTop = (-panY) / zoomLevel - margin;
      const viewRight = (viewportEl.clientWidth - panX) / zoomLevel + margin;
      const viewBottom = (viewportEl.clientHeight - panY) / zoomLevel + margin;

      for (const table of schema.tables) {
        const nodeEl = tableNodeMap.get(table.name);
        if (!nodeEl) continue;
        const inView =
          table.x + TABLE_WIDTH >= viewLeft &&
          table.x <= viewRight &&
          table.y + 260 >= viewTop &&
          table.y <= viewBottom;
        const shouldShow = inView || (draggingTable && draggingTable.table.name === table.name);
        nodeEl.style.display = shouldShow ? '' : 'none';
      }
    }

    let lastDragSent = 0;
    // Arrastre libre infinito en las 4 direcciones + movimiento de tablas sin bordes
    window.addEventListener('mousemove', e => {
      if (!draggingTable && !connectingFrom && !isPanningCanvas) return;
      if (rafPending) return;
      rafPending = true;

      requestAnimationFrame(() => {
        rafPending = false;
        if (isPanningCanvas) {
          panX = panStartScroll.left + (e.clientX - panStartMouse.x);
          panY = panStartScroll.top + (e.clientY - panStartMouse.y);
          applyCameraTransform();
          renderEdges();
          if (schema.tables.length > 30) updateViewportCulling();
          return;
        }
        if (draggingTable) {
          const dx = (e.clientX - dragStartMouse.x) / zoomLevel;
          const dy = (e.clientY - dragStartMouse.y) / zoomLevel;
          draggingTable.table.x = Math.round(dragStartTable.x + dx);
          draggingTable.table.y = Math.round(dragStartTable.y + dy);
          draggingTable.nodeEl.style.transform = \`translate3d(\${draggingTable.table.x}px, \${draggingTable.table.y}px, 0)\`;
          recomputePortCoordinatesForTable(draggingTable.table);
          updateEdgesForTable(draggingTable.table.name);
          const now = Date.now();
          if (isCollabActive && now - lastDragSent > 50) {
            lastDragSent = now;
            sendCollabDelta({
              kind: 'moveTable',
              tableName: draggingTable.table.name,
              x: draggingTable.table.x,
              y: draggingTable.table.y
            });
          }
        } else if (connectingFrom) {
          const vpRect = viewportEl.getBoundingClientRect();
          renderEdges({
            x: (e.clientX - vpRect.left - panX) / zoomLevel,
            y: (e.clientY - vpRect.top - panY) / zoomLevel
          });
        }
      });
    });

    window.addEventListener('mouseup', () => {
      document.body.classList.remove('is-interacting');
      if (isPanningCanvas) {
        isPanningCanvas = false;
        viewportEl.classList.remove('panning');
      }
      if (draggingTable) {
        draggingTable = null;
        vscode.postMessage({ type: 'updateLayoutOnly', schema });
      }
      if (connectingFrom) {
        connectingFrom = null;
        renderEdges();
      }
    });

    // Arrastrar el fondo con el mouse (Panning libre infinito en cualquier dirección)
    viewportEl.addEventListener('mousedown', e => {
      const isBg =
        e.target.id === 'viewport' ||
        e.target.id === 'canvas-scaler' ||
        e.target.id === 'canvas' ||
        e.target.id === 'edges-canvas' ||
        e.target.id === 'nodes-layer' ||
        e.button === 1;
      if (isBg) {
        isPanningCanvas = true;
        panStartMouse.x = e.clientX;
        panStartMouse.y = e.clientY;
        panStartScroll.left = panX;
        panStartScroll.top = panY;
        viewportEl.classList.add('panning');
        document.body.classList.add('is-interacting');

        if (selectedTableName) {
          selectedTableName = null;
          if (isolateNeighbors) {
            renderSchema();
          } else {
            document.querySelectorAll('.table-node.selected-table').forEach(el => el.classList.remove('selected-table'));
            renderEdges();
          }
        }
      }
    });

    dialectSelect.addEventListener('change', () => {
      schema.dialect = dialectSelect.value;
      syncToExtension();
    });

    document.getElementById('add-table-btn').addEventListener('click', () => {
      const index = schema.tables.length + 1;
      const pkType =
        schema.dialect === 'dbml'
          ? 'string(26)'
          : schema.dialect === 'postgres'
          ? 'SERIAL'
          : schema.dialect === 'sqlite'
          ? 'INTEGER'
          : 'INT AUTO_INCREMENT';

      const newTableName = \`tabla_\${index}\`;
      progressiveSet.add(newTableName);
      schema.tables.push({
        name: newTableName,
        x: 80 + ((index - 1) % 4) * 330,
        y: 80 + Math.floor((index - 1) / 4) * 240,
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
            type: schema.dialect === 'dbml' ? 'timestamp' : 'TIMESTAMP',
            isPrimaryKey: false,
            isNullable: false,
            isUnique: false
          }
        ]
      });
      renderSchema();
      syncToExtension();
    });

    // Auto-Ordenar inteligente: agrupa por grado de conectividad (tablas maestro arriba/izquierda)
    document.getElementById('auto-layout-btn').addEventListener('click', () => {
      const connectionScore = new Map();
      for (const t of schema.tables) connectionScore.set(t.name, 0);
      for (const r of schema.relations) {
        connectionScore.set(r.toTable, (connectionScore.get(r.toTable) || 0) + 2);
        connectionScore.set(r.fromTable, (connectionScore.get(r.fromTable) || 0) + 1);
      }

      const sorted = [...schema.tables].sort(
        (a, b) => (connectionScore.get(b.name) || 0) - (connectionScore.get(a.name) || 0)
      );

      const cols = sorted.length > 35 ? 6 : sorted.length > 16 ? 5 : sorted.length > 8 ? 4 : 3;
      const rowHeights = compactMode ? 220 : 360;

      sorted.forEach((t, idx) => {
        t.x = 60 + (idx % cols) * 330;
        t.y = 75 + Math.floor(idx / cols) * rowHeights;
      });
      renderSchema();
      syncToExtension();
    });

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'schemaUpdated') {
        schema = msg.schema;
        renderSchema();
      } else if (msg.type === 'hostRoomStarted') {
        isCollabActive = true;
        hostRoomBtn.textContent = '🟢 Sala Activa (' + msg.port + ')';
        hostRoomBtn.classList.add('active-toggle');
        stopRoomBtn.style.display = 'inline-block';
        stopRoomBtn.textContent = '🔴 Detener Sala';
        joinUrlInput.value = msg.roomUrl;
        if (Array.isArray(msg.peers)) {
          renderPeersBadge(msg.peers);
        }
      } else if (msg.type === 'joinedRoomSuccess') {
        isCollabActive = true;
        joinUrlInput.value = msg.roomUrl;
        joinRoomBtn.textContent = '🟢 Conectado';
        joinRoomBtn.classList.add('active-toggle');
        stopRoomBtn.style.display = 'inline-block';
        stopRoomBtn.textContent = '🔴 Salir';
      } else if (msg.type === 'roomStopped') {
        isCollabActive = false;
        hostRoomBtn.textContent = '🟢 Compartir Sala';
        hostRoomBtn.classList.remove('active-toggle');
        joinRoomBtn.textContent = '🔗 Unirse';
        joinRoomBtn.classList.remove('active-toggle');
        stopRoomBtn.style.display = 'none';
        peersBadge.style.display = 'none';
        remotePeers.clear();
        renderRemoteCursors();
      } else if (msg.type === 'peersUpdated' && Array.isArray(msg.peers)) {
        renderPeersBadge(msg.peers);
        const activeIds = new Set(msg.peers.map(p => p.peerId));
        for (const k of remotePeers.keys()) {
          if (!activeIds.has(k)) remotePeers.delete(k);
        }
        renderRemoteCursors();
      } else if (msg.type === 'remoteCursor' && msg.peer) {
        remotePeers.set(msg.peer.peerId, msg.peer);
        renderRemoteCursors();
      } else if (msg.type === 'remoteDelta') {
        renderSchema();
      }
    });

    resizeEdgesCanvas();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

export class SqlErdSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sqlErd.sidebarView';
  private _view?: vscode.WebviewView;
  private lastHostInfo: {
    roomUrl: string;
    port: number;
    allUrls: { label: string; url: string }[];
  } | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public notifyHostStarted(
    roomUrl: string,
    port: number,
    allUrls: { label: string; url: string }[],
    peers: any[] = []
  ) {
    this.lastHostInfo = { roomUrl, port, allUrls };
    if (this._view) {
      this._view.webview.postMessage({
        type: 'hostInfo',
        ...this.lastHostInfo,
        peers
      });
    }
  }

  public notifyPeersUpdated(peers: any[]) {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'peersList',
        peers
      });
    }
  }

  public notifyRoomStopped() {
    this.lastHostInfo = null;
    if (this._view) {
      this._view.webview.postMessage({
        type: 'roomStopped'
      });
    }
  }

  public async resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getSidebarHtml();

    const sendFilesList = async () => {
      const uris = await vscode.workspace.findFiles(
        '**/*.{sql,ddl,dbml,erd}',
        '**/node_modules/**',
        40
      );
      const files = uris.map(u => ({
        name: path.basename(u.fsPath),
        relPath: vscode.workspace.asRelativePath(u),
        uri: u.toString()
      }));
      webviewView.webview.postMessage({ type: 'filesList', files });
      if (this.lastHostInfo) {
        webviewView.webview.postMessage({
          type: 'hostInfo',
          ...this.lastHostInfo
        });
      }
    };

    webviewView.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'ready' || msg.type === 'refreshFiles') {
        await sendFilesList();
      } else if (msg.type === 'openDiagram') {
        const uri = msg.uri
          ? vscode.Uri.parse(msg.uri)
          : vscode.window.activeTextEditor?.document.uri;
        if (uri) {
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
          await vscode.commands.executeCommand(
            'vscode.openWith',
            uri,
            SqlErdEditorProvider.viewType,
            vscode.ViewColumn.Beside
          );
        } else {
          vscode.window.showWarningMessage(
            'Selecciona o abre primero un archivo .sql o .dbml.'
          );
        }
      } else if (msg.type === 'joinRoom') {
        const url = String(msg.roomUrl || '').trim();
        if (url) {
          await vscode.commands.executeCommand(
            'sqlErd.joinCollabRoom',
            url,
            Boolean(msg.bridgeOnly)
          );
        }
      } else if (msg.type === 'copyUrl') {
        vscode.env.clipboard.writeText(String(msg.url || ''));
        vscode.window.showInformationMessage(`Copiado: ${msg.url}`);
      } else if (msg.type === 'stopAllRooms') {
        for (const stopFn of activeRoomStoppers) {
          stopFn();
        }
        vscode.window.showInformationMessage('Sala colaborativa detenida.');
      } else if (msg.type === 'connectRemoteDb') {
        const cfg: RemoteDbConfig = msg.config;
        try {
          vscode.window.showInformationMessage(
            `Conectando al servidor remoto (${cfg.host}) y extrayendo metadatos ligeros...`
          );
          const remoteSchema = await fetchRemoteDatabaseSchema(cfg);
          if (remoteSchema.tables.length === 0) {
            vscode.window.showWarningMessage(
              'La consulta remota no devolvió tablas (verifica el nombre de base de datos, esquema o filtro).'
            );
            return;
          }
          const sqlText = generateSqlFromSchema(remoteSchema);
          const workspaceDir =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.tmpdir();
          const safeDbName = (cfg.database || 'remote_db')
            .replace(/[^a-zA-Z0-9_-]/g, '_');
          const localFilePath = path.join(workspaceDir, `${safeDbName}_remote.sql`);
          fs.writeFileSync(localFilePath, sqlText, 'utf8');

          const fileUri = vscode.Uri.file(localFilePath);
          const doc = await vscode.workspace.openTextDocument(fileUri);
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
          await vscode.commands.executeCommand(
            'vscode.openWith',
            fileUri,
            SqlErdEditorProvider.viewType,
            vscode.ViewColumn.Beside
          );
          vscode.window.showInformationMessage(
            `¡Esquema remoto cargado con éxito (${remoteSchema.tables.length} tablas, ${remoteSchema.relations.length} relaciones, 0 filas pesadas)!`
          );
        } catch (err) {
          vscode.window.showErrorMessage(
            `Error al extraer esquema remoto: ${String(err)}`
          );
        }
      } else if (msg.type === 'openPortsView') {
        await vscode.commands.executeCommand('~ports.focus');
      }
    });
  }

  private getSidebarHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <style>
    body {
      padding: 10px;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: 12px;
    }
    .card {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 12px;
    }
    h3 {
      margin: 0 0 8px 0;
      font-size: 12.5px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    input[type="text"], input[type="password"], input[type="number"], select {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 8px;
      margin-bottom: 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      font-size: 12px;
    }
    button {
      width: 100%;
      padding: 6px 10px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 600;
      font-size: 12px;
      margin-bottom: 6px;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .ip-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
      background: rgba(0,0,0,0.18);
      padding: 5px 6px;
      border-radius: 4px;
      margin-top: 5px;
      font-size: 11px;
    }
    .ip-row code {
      color: #38bdf8;
      word-break: break-all;
    }
    .ip-row button {
      width: auto;
      padding: 2px 6px;
      margin: 0;
      font-size: 10.5px;
    }
    .file-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 5px 6px;
      border-bottom: 1px solid rgba(128,128,128,0.15);
      cursor: pointer;
      border-radius: 4px;
    }
    .file-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .hint {
      font-size: 11px;
      opacity: 0.8;
      line-height: 1.4;
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h3>🔗 Unirse a Sala / Puente Remoto</h3>
    <input id="room-url" type="text" placeholder="Ej: http://192.168.1.50:4580" />
    <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:11px;cursor:pointer;">
      <input id="bridge-only-chk" type="checkbox" checked />
      <span>⚡ <b>Modo Puente Ligero</b> (0 carga en tu PC: no crea ni procesa archivo local)</span>
    </label>
    <button id="join-btn">Conectar al Puente / Sala</button>
    <div class="hint">
      En <b>Modo Puente Ligero</b>, el servidor remoto o anfitrión lleva toda la carga del archivo y tu VS Code funciona solo como visor/editor ultraligero.
    </div>
  </div>

  <div class="card">
    <h3>🟢 Estado de tu Sala y Conectados</h3>
    <div id="host-status" class="hint">
      Abre un diagrama y pulsa <b>"🟢 Compartir Sala"</b> en la barra superior para generar tus enlaces de red.
    </div>
    <button id="stop-room-sidebar-btn" style="display:none;background:#dc2626;color:#fff;margin-top:6px;">🔴 Detener / Salir de Sala Colaborativa</button>
    <div id="peers-container" style="margin-top:8px;"></div>
    <div id="ips-list"></div>
    <div class="hint" style="margin-top:8px;">
      💡 <b>¿No les carga tu IP local?</b> Si usas <b>WSL2</b> o el <b>Firewall de Windows</b> bloquea el puerto <code>4580</code>, ve a la pestaña <b>Puertos (Ports)</b> de VS Code abajo, agrega el puerto <b>4580</b>, cámbialo a <b>Public</b> y pásales esa URL <code>https://...devtunnels.ms</code>.
    </div>
  </div>

  <div class="card">
    <h3>☁️ Conexión a BD Remota (Ligera)</h3>
    <select id="db-engine">
      <option value="postgres">PostgreSQL Remoto (Metadatos)</option>
      <option value="url">URL Remota (.sql / .dbml)</option>
    </select>
    <div id="pg-fields">
      <div style="display:flex;gap:6px;">
        <input id="db-host" type="text" placeholder="Host / IP (ej. 10.0.0.15)" style="flex:2;" />
        <input id="db-port" type="number" placeholder="5432" value="5432" style="flex:1;" />
      </div>
      <div style="display:flex;gap:6px;">
        <input id="db-user" type="text" placeholder="Usuario (postgres)" style="flex:1;" />
        <input id="db-pass" type="password" placeholder="Contraseña" style="flex:1;" />
      </div>
      <div style="display:flex;gap:6px;">
        <input id="db-name" type="text" placeholder="Base de Datos" style="flex:1;" />
        <input id="db-schema" type="text" placeholder="Esquema (public)" value="public" style="flex:1;" />
      </div>
      <input id="db-filter" type="text" placeholder="Filtro opcional de tablas (ej: mnt_%)" />
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:11px;cursor:pointer;">
        <input id="db-ssl" type="checkbox" /> Usar conexión segura SSL / TLS
      </label>
    </div>
    <div id="url-fields" style="display:none;">
      <input id="db-remote-url" type="text" placeholder="https://servidor.com/esquema.sql" />
    </div>
    <button id="connect-db-btn">⚡ Extraer Esquema sin Sobrecargar PC</button>
    <div class="hint">
      Consulta únicamente <code>information_schema</code> en el servidor remoto (0 filas de datos) y puedes filtrar por módulo (<code>mnt_%</code>) para no consumir memoria en tu PC.
    </div>
  </div>

  <div class="card">
    <h3>📂 Archivos SQL / DBML del Proyecto</h3>
    <button class="secondary" id="open-active-btn">Abrir Diagrama del Archivo Actual</button>
    <div id="files-container" class="hint">Buscando archivos...</div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    document.getElementById('join-btn').addEventListener('click', () => {
      const roomUrl = document.getElementById('room-url').value.trim();
      const bridgeOnly = document.getElementById('bridge-only-chk').checked;
      if (roomUrl) {
        vscode.postMessage({ type: 'joinRoom', roomUrl, bridgeOnly });
      }
    });

    document.getElementById('open-active-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'openDiagram' });
    });

    const dbEngineSelect = document.getElementById('db-engine');
    const pgFields = document.getElementById('pg-fields');
    const urlFields = document.getElementById('url-fields');

    dbEngineSelect.addEventListener('change', () => {
      if (dbEngineSelect.value === 'url') {
        pgFields.style.display = 'none';
        urlFields.style.display = 'block';
      } else {
        pgFields.style.display = 'block';
        urlFields.style.display = 'none';
      }
    });

    document.getElementById('connect-db-btn').addEventListener('click', () => {
      const engine = dbEngineSelect.value;
      if (engine === 'url') {
        const remoteUrl = document.getElementById('db-remote-url').value.trim();
        if (!remoteUrl) return;
        vscode.postMessage({
          type: 'connectRemoteDb',
          config: {
            engine: 'url',
            host: remoteUrl,
            port: 443,
            user: '',
            database: 'remote_url'
          }
        });
      } else {
        const host = document.getElementById('db-host').value.trim() || 'localhost';
        const port = Number(document.getElementById('db-port').value) || 5432;
        const user = document.getElementById('db-user').value.trim() || 'postgres';
        const password = document.getElementById('db-pass').value;
        const database = document.getElementById('db-name').value.trim() || 'postgres';
        const dbSchema = document.getElementById('db-schema').value.trim() || 'public';
        const tableFilter = document.getElementById('db-filter').value.trim();
        const ssl = document.getElementById('db-ssl').checked;
        vscode.postMessage({
          type: 'connectRemoteDb',
          config: {
            engine: 'postgres',
            host,
            port,
            user,
            password,
            database,
            dbSchema,
            tableFilter: tableFilter || undefined,
            ssl
          }
        });
      }
    });

    const stopSidebarBtn = document.getElementById('stop-room-sidebar-btn');
    const peersContainer = document.getElementById('peers-container');

    stopSidebarBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'stopAllRooms' });
    });

    function renderSidebarPeers(peers) {
      if (!Array.isArray(peers) || peers.length === 0) {
        peersContainer.innerHTML = '';
        return;
      }
      stopSidebarBtn.style.display = 'block';
      peersContainer.innerHTML =
        '<div style="font-weight:700;margin-bottom:4px;">👥 Usuarios en la sala (' + peers.length + '):</div>' +
        peers
          .map(
            p =>
              '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 6px;background:rgba(255,255,255,0.05);border-radius:4px;margin-bottom:3px;">' +
              '<span style="display:flex;align-items:center;gap:6px;"><span style="width:9px;height:9px;border-radius:50%;background:' +
              (p.color || '#38bdf8') +
              ';display:inline-block;"></span><b>' +
              p.name +
              '</b></span>' +
              '<span style="opacity:0.75;font-size:10.5px;">' +
              (p.activeTable ? 'Editando: ' + p.activeTable : 'En línea') +
              '</span></div>'
          )
          .join('');
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'hostInfo') {
        stopSidebarBtn.style.display = 'block';
        document.getElementById('host-status').innerHTML =
          '<b>¡Sala activa en puerto ' + msg.port + '!</b> Comparte la IP de tu red Wi-Fi/LAN (no la de WSL/Virtual):';
        if (msg.peers) {
          renderSidebarPeers(msg.peers);
        }
        const ipsList = document.getElementById('ips-list');
        ipsList.innerHTML = '';
        (msg.allUrls || []).forEach(item => {
          const row = document.createElement('div');
          row.className = 'ip-row';
          row.innerHTML = '<div><div>' + item.label + '</div><code>' + item.url + '</code></div>';
          const btn = document.createElement('button');
          btn.textContent = 'Copiar';
          btn.addEventListener('click', () => {
            vscode.postMessage({ type: 'copyUrl', url: item.url });
          });
          row.appendChild(btn);
          ipsList.appendChild(row);
        });
      } else if (msg.type === 'peersList') {
        renderSidebarPeers(msg.peers);
      } else if (msg.type === 'roomStopped') {
        stopSidebarBtn.style.display = 'none';
        peersContainer.innerHTML = '';
        document.getElementById('ips-list').innerHTML = '';
        document.getElementById('host-status').innerHTML =
          'Sala detenida. Abre un diagrama y pulsa <b>"🟢 Compartir Sala"</b> para iniciar una nueva.';
      } else if (msg.type === 'filesList') {
        const container = document.getElementById('files-container');
        if (!msg.files || msg.files.length === 0) {
          container.textContent = 'No se encontraron archivos .sql o .dbml en esta carpeta.';
          return;
        }
        container.innerHTML = '';
        msg.files.forEach(f => {
          const item = document.createElement('div');
          item.className = 'file-item';
          item.innerHTML = '<span>📄 ' + f.relPath + '</span><span style="color:#38bdf8;font-weight:600;">Ver ERD →</span>';
          item.addEventListener('click', () => {
            vscode.postMessage({ type: 'openDiagram', uri: f.uri });
          });
          container.appendChild(item);
        });
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

export function deactivate() {}
