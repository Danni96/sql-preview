import * as fs from 'fs';
import * as path from 'path';
import {
  parseSqlToSchema,
  generateSqlFromSchema,
  SqlSchema
} from './sqlParser';
import {
  SqlCollabRoomServer,
  applyDeltaToSchema,
  CollabDelta,
  getAllLocalIps
} from './collabServer';

/**
 * Servidor Puente Remoto Independiente (Headless Bridge Server)
 * Permite alojar y procesar archivos .sql / .dbml grandes en un servidor remoto
 * para que las PCs del equipo solo se conecten como visores ligeros sin carga local.
 *
 * Uso: node out/remoteBridgeServer.js [ruta-archivo.sql] [puerto]
 */
export async function startStandaloneBridgeServer(
  filePathArg?: string,
  portArg = 4580
): Promise<SqlCollabRoomServer> {
  const targetFile = path.resolve(
    filePathArg || path.join(__dirname, '..', 'examples', 'ecommerce_schema.sql')
  );

  if (!fs.existsSync(targetFile)) {
    fs.writeFileSync(
      targetFile,
      '-- @sql-erd-dialect: postgres\nCREATE TABLE ejemplo (\n  id SERIAL PRIMARY KEY,\n  nombre VARCHAR(120) NOT NULL\n);\n',
      'utf8'
    );
  }

  let currentSchema: SqlSchema = parseSqlToSchema(fs.readFileSync(targetFile, 'utf8'));
  let saveTimer: NodeJS.Timeout | null = null;

  const scheduleDiskSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const outText = generateSqlFromSchema(currentSchema);
        fs.writeFileSync(targetFile, outText, 'utf8');
      } catch (err) {
        console.error('Error guardando archivo en servidor puente:', err);
      }
    }, 500);
  };

  const server = new SqlCollabRoomServer(
    () => path.basename(targetFile),
    () => currentSchema,
    (delta: CollabDelta) => {
      if (delta.kind !== 'cursor' && applyDeltaToSchema(currentSchema, delta)) {
        scheduleDiskSave();
      }
    },
    () => `<!DOCTYPE html><html><body style="background:#0f172a;color:#e2e8f0;font-family:sans-serif;padding:24px;">
      <h2>☁️ SQL ERD Remote Bridge Server Activo</h2>
      <p>Archivo alojado: <code>${path.basename(targetFile)}</code> (${currentSchema.tables.length} tablas, ${currentSchema.relations.length} relaciones)</p>
      <p>Conéctate desde la barra lateral de VS Code usando esta URL.</p>
    </body></html>`
  );

  const port = await server.start(portArg);
  const ips = getAllLocalIps();
  console.log('====================================================');
  console.log(`☁️  SQL ERD Remote Bridge Server activo en puerto ${port}`);
  console.log(`📄 Archivo gestionado en servidor: ${targetFile}`);
  console.log(`📊 Esquema cargado: ${currentSchema.tables.length} tablas · ${currentSchema.relations.length} relaciones`);
  for (const ip of ips) {
    console.log(`🔗 Conectar desde VS Code: http://${ip.address}:${port}`);
  }
  console.log('====================================================');
  return server;
}

if (require.main === module) {
  const fileArg = process.argv[2];
  const portArg = Number(process.argv[3]) || 4580;
  startStandaloneBridgeServer(fileArg, portArg).catch(err => {
    console.error('Error al iniciar Remote Bridge Server:', err);
    process.exit(1);
  });
}
